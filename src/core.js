import path from 'path'
import bl from 'bl'
import _debug from 'debug'
import FormData from 'form-data'
import mime from 'mime'
import { storeSessionFile } from './util/global'
import {
  getCONF,
  Request,
  isStandardBrowserEnv,
  assert,
  getClientMsgId,
  getDeviceID
} from './util'
import fs from 'fs'

const debug = _debug('core')

export default class WechatCore {

  constructor (hotRelaod = true) {
    this.PROP = {
      uuid: '',
      uin: '',
      sid: '',
      skey: '',
      passTicket: '',
      formatedSyncKey: '',
      webwxDataTicket: '',
      syncKey: {
        List: []
      }
    }
    this.CONF = getCONF()
    this.COOKIE = {}
    this.user = {}                // 当前登录用户信息
    this.storeData = null         // 保存当前登录数据信息
    if (hotRelaod) {
      this.storeData = this.getCookiesFromFile()
    }
    this.online = false            // 是否在线
    this.memberList = []           // 好友+群聊+公众号+特殊账号
    this.contactList = []          // 好友
    this.groupList = []            // 群
    this.groupMemeberMap = []      // 群聊成员字典
    this.publicUsersList = []      // 公众号／服务号
    this.specialUsersList = []     // 特殊账号
    this.groupIdList = []          // 群ID列表
    this.groupNickNameList = []    // 群NickName列表

    this.request = new Request({
      Cookie: this.COOKIE
    })
  }

  get storeData () {
    return {
      PROP: this.PROP,
      CONF: this.CONF,
      COOKIE: this.COOKIE,
      user: this.user
    }
  }

  set storeData (data) {
    if (!data) {
      return
    }
    Object.keys(data).forEach(key => {
      Object.assign(this[key], data[key])
    })
  }

  getCookiesFromFile () {
    try {
      fs.statSync(storeSessionFile).isFile()
    } catch (err) {
      debug('WeChatCore', 'getCookiesFromFile() no cookies => ', err.message)
      return null
    }
    const jsonStr = fs.readFileSync(storeSessionFile)
    const cookies = JSON.parse(jsonStr.toString())
    return cookies
  }

  cleanCookies () {
    debug('WeChatCore', 'cleanCookies() file =>', storeSessionFile)
    fs.unlinkSync(storeSessionFile)
  }

  saveCookies () {
    try {
      const jsonStr = JSON.stringify(this.storeData)
      fs.writeFileSync(storeSessionFile, jsonStr)
    } catch (e) {
      console.log('WeChatCore', 'saveCookies exception: ', e.message)
      throw e
    }
  }

  /**
   * 获取UUID
   * @returns 
   * @memberof WechatCore
   */
  async getUUID () {
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_jsLogin
    })
    let window = {
      QRLogin: {}
    }
    // res.data: "window.QRLogin.code = xxx; ..."
    // eslint-disable-next-line
    eval(res.data)
    assert.equal(window.QRLogin.code, 200, res)
    this.PROP.uuid = window.QRLogin.uuid
    return window.QRLogin.uuid
  }

  /**
   * 获取手机确认登录信息
   * @returns 
   * @memberof WechatCore
   */
  async checkLogin () {
    let params = {
      'tip': 0,
      'uuid': this.PROP.uuid,
      'loginicon': true
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_login,
      params
    })
    let window = {}

    // eslint-disable-next-line
    eval(res.data)
    assert.notEqual(window.code, 400, res)

    if (window.code === 200) {
      this.CONF = getCONF(window.redirect_uri.match(/(?:\w+\.)+\w+/)[0])
      this.rediUri = window.redirect_uri
    } else if (window.code === 201 && window.userAvatar) {
      // this.user.userAvatar = window.userAvatar
    }
    return window
  }

  async login () {
    const res = await this.request({
      method: 'GET',
      url: this.rediUri,
      params: {
        fun: 'new'
      }
    })
    let pm = res.data.match(/<ret>(.*)<\/ret>/)
    if (pm && pm[1] === '0') {
      this.PROP.skey = res.data.match(/<skey>(.*)<\/skey>/)[1]
      this.PROP.sid = res.data.match(/<wxsid>(.*)<\/wxsid>/)[1]
      this.PROP.uin = res.data.match(/<wxuin>(.*)<\/wxuin>/)[1]
      this.PROP.passTicket = res.data.match(/<pass_ticket>(.*)<\/pass_ticket>/)[1]
    } else {
      //add by WuQic 2017-09-15
      //如果登录被禁止时，则登录返回的message内容不为空，下面代码则判断登录内容是否为空，不为空则退出程序
      console.log(res.data)
      process.exit(0)
    }

    if (res.headers['set-cookie']) {
      res.headers['set-cookie'].forEach(item => {
        if (/webwx.*?data.*?ticket/i.test(item)) {
          this.PROP.webwxDataTicket = item.match(/=(.*?);/)[1]
        } else if (/wxuin/i.test(item)) {
          this.PROP.uin = item.match(/=(.*?);/)[1]
        } else if (/wxsid/i.test(item)) {
          this.PROP.sid = item.match(/=(.*?);/)[1]
        }
      })
    }
    // 保存数据，将数据序列化之后保存到任意位置
    this.saveCookies()
    debug('登录成功')
  }

  /**
   * 微信初始化
   * @returns 
   * @memberof WechatCore
   */
  async init () {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'skey': this.PROP.skey,
      'r': ~new Date()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxinit,
      params,
      data: {
        BaseRequest: this.getBaseRequest()
      }
    })
    const { data: resData }  = res
    const { BaseResponse: { Ret }, User, ChatSet, SKey } = resData
    // 检查是否已退出
    this.checkExit(Ret)
    assert.equal(Ret, 0, res)
    this.PROP.skey = SKey || this.PROP.skey
    this.updateSyncKey(resData)
    Object.assign(this.user, User)
    // 保存群id
    this.groupIdList = ChatSet.split(',').filter(id => id.startsWith('@@'))
    return resData
  }

  /**
   * 开启微信状态通知
   * @param {any} to 
   * @memberof WechatCore
   */
  async notifyMobile (to) {
    let params = {
      pass_ticket: this.PROP.passTicket,
      lang: 'zh_CN'
    }
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Code': to ? 1 : 3,
      'FromUserName': this.user['UserName'],
      'ToUserName': to || this.user['UserName'],
      'ClientMsgId': getClientMsgId()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxstatusnotify,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
  }

  /**
   * 获取联系人列表
   * @param {number} [seq=0] 
   * @returns 
   * @memberof WechatCore
   */
  async getContact (seq = 0) {
    let params = {
      'lang': 'zh_CN',
      'pass_ticket': this.PROP.passTicket,
      'seq': seq,
      'skey': this.PROP.skey,
      'r': +new Date()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxgetcontact,
      params
    })
    let { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 批量获取联系人
   * @param {any} contacts 
   * @returns 
   * @memberof WechatCore
   */
  async batchGetContact () {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'type': 'ex',
      'r': +new Date(),
      'lang': 'zh_CN'
    }
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Count': this.groupIdList.length,
      'List': this.groupIdList
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxbatchgetcontact,
      params,
      data: paramData
    })
    let { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data.ContactList
  }

  /**
   * 状态报告
   * @param {any} text 
   * @memberof WechatCore
   */
  async statReport (text) {
    text = text || {
      'type': '[action-record]',
      'data': {
        'actions': [{
          'type': 'click',
          'action': '发送框',
          'time': +new Date()
        }]
      }
    }
    text = JSON.stringify(text)
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'fun': 'new',
      'lang': 'zh_CN'
    }
    let data = {
      'BaseRequest': this.getBaseRequest(),
      'Count': 1,
      'List': [{
        'Text': text,
        'Type': 1
      }]
    }
    await this.request({
      method: 'POST',
      url: this.CONF.API_webwxreport,
      params,
      data
    })
  }

  /**
   * 微信消息检查
   * @returns 
   * @memberof WechatCore
   */
  async syncCheck () {
    let params = {
      'r': +new Date(),
      'sid': this.PROP.sid,
      'uin': this.PROP.uin,
      'skey': this.PROP.skey,
      'deviceid': getDeviceID(),
      'synckey': this.PROP.formatedSyncKey
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_synccheck,
      params
    })
    let window = {
      synccheck: {}
    }
    try {
      // eslint-disable-next-line
      eval(res.data)
    } catch (ex) {
      window.synccheck = { retcode: '0', selector: '0' }
    }
    const retcode = Number(window.synccheck.retcode)
    // 检查是否已退出
    this.checkExit(retcode)
    assert.equal(retcode, this.CONF.SYNCCHECK_RET_SUCCESS, res)
    return window.synccheck.selector
  }

  /**
   * 获取最新消息
   * @returns
   * @memberof WechatCore
   */
  async sync () {
    let params = {
      'sid': this.PROP.sid,
      'skey': this.PROP.skey,
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'SyncKey': this.PROP.syncKey,
      'rr': ~new Date()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsync,
      params,
      data: paramData
    })
    let { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    this.updateSyncKey(data)
    this.PROP.skey = data.SKey || this.PROP.skey
    return data
  }

  /**
   * 保存登录同步信息
   * @param {any} data 
   * @memberof WechatCore
   */
  updateSyncKey (data) {
    if (data.SyncKey) {
      this.PROP.syncKey = data.SyncKey
    }
    if (data.SyncCheckKey) {
      let synckeylist = []
      for (let e = data.SyncCheckKey.List, o = 0, n = e.length; n > o; o++) {
        synckeylist.push(e[o]['Key'] + '_' + e[o]['Val'])
      }
      this.PROP.formatedSyncKey = synckeylist.join('|')
    } else if (!this.PROP.formatedSyncKey && data.SyncKey) {
      let synckeylist = []
      for (let e = data.SyncKey.List, o = 0, n = e.length; n > o; o++) {
        synckeylist.push(e[o]['Key'] + '_' + e[o]['Val'])
      }
      this.PROP.formatedSyncKey = synckeylist.join('|')
    }
  }

  checkExit (retcode) {
    this.online = true
    if (retcode === this.CONF.LOGIN_OTHERWHERE || retcode === this.CONF.LOGIN_OUT || retcode === this.CONF.MOBILE_LOGIN_OUT) {
      this.online = false
      debug(`微信手机端退出: ${retcode}`)
      this.cleanCookies()
      process.exit(0)
    }
  }

  /**
   * 退出
   * @memberof WechatCore
   */
  async logout () {
    let params = {
      redirect: 1,
      type: 0,
      skey: this.PROP.skey,
      lang: 'zh_CN'
    }

    // data加上会出错，不加data也能登出
    // let data = {
    //   sid: this.PROP.sid,
    //   uin: this.PROP.uin
    // }
    await this.request({
      method: 'POST',
      url: this.CONF.API_webwxlogout,
      params
    })
    if (fs.exists(storeSessionFile)) {
      console.log('clear hot-realod data')
      // 清除数据
      fs.unlinkSync(storeSessionFile)
    }
    debug('登出成功')
  }

  /**
   * 发送文本消息
   * @param {any} msg 
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
   */
  async sendText(msg, to) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 0,
      'Msg': {
        'Type': this.CONF.MSGTYPE_TEXT,
        'Content': msg,
        'FromUserName': this.user['UserName'],
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsg,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 发送表情
   * @param {any} id 
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
   */
  async sendEmoticon (id, to) {
    let params = {
      'fun': 'sys',
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 0,
      'Msg': {
        'Type': this.CONF.MSGTYPE_EMOTICON,
        'EmojiFlag': 2,
        'FromUserName': this.user['UserName'],
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    if (id.indexOf('@') === 0) {
      paramData.Msg.MediaId = id
    } else {
      paramData.Msg.EMoticonMd5 = id
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendemoticon,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  // file: Stream, Buffer, File, Blob
  /**
   * 上传媒体文件
   * @param {any} file 
   * @param {any} filename 
   * @param {any} toUserName 
   * @returns 
   * @memberof WechatCore
   */
  async uploadMedia (file, filename, toUserName) {
    let name, type, size, ext, mediatype, paramData
    if ((typeof (File) !== 'undefined' && file.constructor === File) ||
      (typeof (Blob) !== 'undefined' && file.constructor === Blob)) {
      name = file.name || 'file'
      type = file.type
      size = file.size
      paramData = file
    } else if (Buffer.isBuffer(file)) {
      if (!filename) {
        return new Error('文件名未知')
      }
      name = filename
      type = mime.lookup(name)
      size = file.length
      paramData = file
    } else if (file.readable) {
      if (!file.path && !filename) {
        return new Error('文件名未知')
      }
      name = path.basename(file.path || filename)
      type = mime.lookup(name)
      file.pipe(bl((err, buffer) => {
        if (err) {
          throw err
        }
        size = buffer.length
        paramData = buffer
      }))
    }
    ext = name.match(/.*\.(.*)/)
    if (ext) {
      ext = ext[1].toLowerCase()
    } else {
      ext = ''
    }
    switch (ext) {
      case 'bmp':
      case 'jpeg':
      case 'jpg':
      case 'png':
        mediatype = 'pic'
        break
      case 'mp4':
        mediatype = 'video'
        break
      default:
        mediatype = 'doc'
    }

    let clientMsgId = getClientMsgId()

    let uploadMediaRequest = JSON.stringify({
      BaseRequest: this.getBaseRequest(),
      ClientMediaId: clientMsgId,
      TotalLen: size,
      StartPos: 0,
      DataLen: size,
      MediaType: 4,
      UploadType: 2,
      FromUserName: this.user.UserName,
      ToUserName: toUserName || this.user.UserName
    })
    let form = new FormData()
    form.append('name', name)
    form.append('type', type)
    form.append('lastModifiedDate', new Date().toGMTString())
    form.append('size', size)
    form.append('mediatype', mediatype)
    form.append('uploadmediarequest', uploadMediaRequest)
    form.append('webwx_data_ticket', this.PROP.webwxDataTicket)
    form.append('pass_ticket', encodeURI(this.PROP.passTicket))
    form.append('filename', paramData, {
      filename: name,
      contentType: type,
      knownLength: size
    })
    if (isStandardBrowserEnv) {
      paramData = {
        data: form,
        headers: {}
      }
    } else {
      form.pipe(bl((err, buffer) => {
        if (err) {
          throw err
        }
        paramData = {
          data: buffer,
          headers: form.getHeaders()
        }
      }))
    }
    let params = {
      f: 'json'
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxuploadmedia,
      headers: paramData.data.headers,
      params,
      data: paramData.data
    })
    const { data: { mediaId } } = res
    assert.ok(mediaId, res)
    return {
      name,
      size,
      ext,
      mediatype,
      mediaId
    }
  }

  /**
   * 发送图片
   * @param {any} mediaId 
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
   */
  async sendPic (mediaId, to) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'fun': 'async',
      'f': 'json',
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 0,
      'Msg': {
        'Type': this.CONF.MSGTYPE_IMAGE,
        'MediaId': mediaId,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsgimg,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 发送视频
   * @param {any} mediaId 
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
   */
  async sendVideo (mediaId, to) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'fun': 'async',
      'f': 'json',
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 0,
      'Msg': {
        'Type': this.CONF.MSGTYPE_VIDEO,
        'MediaId': mediaId,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendmsgvedio,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 发送文件
   * @param {any} mediaId 
   * @param {any} name 
   * @param {any} size 
   * @param {any} ext 
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
   */
  async sendDoc (mediaId, name, size, ext, to) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'fun': 'async',
      'f': 'json',
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 0,
      'Msg': {
        'Type': this.CONF.APPMSGTYPE_ATTACH,
        'Content': `<appmsg appid='wxeb7ec651dd0aefa9' sdkver=''><title>${name}</title><des></des><action></action><type>6</type><content></content><url></url><lowurl></lowurl><appattach><totallen>${size}</totallen><attachid>${mediaId}</attachid><fileext>${ext}</fileext></appattach><extinfo></extinfo></appmsg>`,
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxsendappmsg,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 转发消息
   * @param {any} msg
   * @param {any} to 
   * @returns 
   * @memberof WechatCore
    */
  async forwardMsg (msg, to) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'fun': 'async',
      'f': 'json',
      'lang': 'zh_CN'
    }
    let clientMsgId = getClientMsgId()
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Scene': 2,
      'Msg': {
        'Type': msg.MsgType,
        'MediaId': '',
        'Content': msg.Content.replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        'FromUserName': this.user.UserName,
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    }
    let url
    switch (msg.MsgType) {
      case this.CONF.MSGTYPE_TEXT:
        url = this.CONF.API_webwxsendmsg
        if (msg.SubMsgType === this.CONF.MSGTYPE_LOCATION) {
          paramData.Msg.Type = this.CONF.MSGTYPE_LOCATION
          paramData.Msg.Content = msg.OriContent.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        }
        break
      case this.CONF.MSGTYPE_IMAGE:
        url = this.CONF.API_webwxsendmsgimg
        break
      case this.CONF.MSGTYPE_EMOTICON:
        url = this.CONF.API_webwxsendemoticon
        params.fun = 'sys'
        paramData.Msg.EMoticonMd5 = msg.Content.replace(/^[\s\S]*?md5\s?=\s?"(.*?)"[\s\S]*?$/, '$1')
        if (!paramData.Msg.EMoticonMd5) {
          throw new Error('商店表情不能转发')
        }
        paramData.Msg.EmojiFlag = 2
        paramData.Scene = 0
        delete paramData.Msg.MediaId
        delete paramData.Msg.Content
        break
      case this.CONF.MSGTYPE_MICROVIDEO:
      case this.CONF.MSGTYPE_VIDEO:
        url = this.CONF.API_webwxsendmsgvedio
        paramData.Msg.Type = this.CONF.MSGTYPE_VIDEO
        break
      case this.CONF.MSGTYPE_APP:
        url = this.CONF.API_webwxsendappmsg
        paramData.Msg.Type = msg.AppMsgType
        paramData.Msg.Content = paramData.Msg.Content.replace(
          /^[\s\S]*?(<appmsg[\s\S]*?<attachid>)[\s\S]*?(<\/attachid>[\s\S]*?<\/appmsg>)[\s\S]*?$/,
          `$1${msg.MediaId}$2`)
        break
      default:
        break
    }
    if (!url) {
      return
    }
    const res = await this.request({
      method: 'POST',
      url,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   *  获取图片或表情
   * @param {any} msgId
   * @returns 
   * @memberof WechatCore
   */
  async getMsgImg (msgId) {
    let params = {
      MsgID: msgId,
      skey: this.PROP.skey,
      type: 'big'
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_webwxgetmsgimg,
      params,
      responseType: 'arraybuffer'
    })
    return {
      data: res.data,
      type: res.headers['content-type']
    }
  }

  /**
   *  获取视频
   * @param {any} msgId
   * @returns 
   * @memberof WechatCore
   */
  async getVideo (msgId) {
    let params = {
      MsgID: msgId,
      skey: this.PROP.skey
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_webwxgetvideo,
      headers: {
        'Range': 'bytes=0-'
      },
      params,
      responseType: 'arraybuffer'
    })
    return {
      data: res.data,
      type: res.headers['content-type']
    }
  }

  /**
   * 获取声音
   * @param {any} msgId
   * @returns 
   * @memberof WechatCore
   */
  async getVoice (msgId) {
    let params = {
      MsgID: msgId,
      skey: this.PROP.skey
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_webwxgetvoice,
      params,
      responseType: 'arraybuffer'
    })
    return {
      data: res.data,
      type: res.headers['content-type']
    }
  }

  /**
   * 获取头像
   * @param {any} HeadImgUrl 
   * @returns 
   * @memberof WechatCore
   */
  async getHeadImg (HeadImgUrl) {
    const url = this.CONF.origin + HeadImgUrl
    const res = await this.request({
      method: 'GET',
      url,
      responseType: 'arraybuffer'
    })
    return {
      data: res.data,
      type: res.headers['content-type']
    }
  }

  /**
   * 获取文件
   * @param {any} FromUserName
   * @param {any} MediaId 
   * @param {any} FileName 
   * @returns 
   * @memberof WechatCore
   */
  async getDoc (FromUserName, MediaId, FileName) {
    let params = {
      sender: FromUserName,
      mediaid: MediaId,
      filename: FileName,
      fromuser: this.user.UserName,
      pass_ticket: this.PROP.passTicket,
      webwx_data_ticket: this.PROP.webwxDataTicket
    }
    const res = await this.request({
      method: 'GET',
      url: this.CONF.API_webwxdownloadmedia,
      params,
      responseType: 'arraybuffer'
    })
    return {
      data: res.data,
      type: res.headers['content-type']
    }
  }

  /**
   * 通过好友请求
   * @param {any} UserName
   * @param {any} Ticket 
   * @returns 
   * @memberof WechatCore
   */
  async verifyUser (UserName, Ticket) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Opcode': 3,
      'VerifyUserListSize': 1,
      'VerifyUserList': [{
        'Value': UserName,
        'VerifyUserTicket': Ticket
      }],
      'VerifyContent': '',
      'SceneListCount': 1,
      'SceneList': [33],
      'skey': this.PROP.skey
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxverifyuser,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 添加好友
   * @param UserName 待添加用户的UserName
   * @param content
   * @returns {Promise.<TResult>}
   */
  async addFriend (UserName, content = '我是' + this.user.NickName) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let paramData = {
      'BaseRequest': this.getBaseRequest(),
      'Opcode': 2,
      'VerifyUserListSize': 1,
      'VerifyUserList': [{
        'Value': UserName,
        'VerifyUserTicket': ''
      }],
      'VerifyContent': content,
      'SceneListCount': 1,
      'SceneList': [33],
      'skey': this.PROP.skey
    }

    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxverifyuser,
      params,
      data: paramData
    })
    let { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  // Topic: Chatroom name
  // MemberList format:
  // [
  //   {"UserName":"@250d8d156ad9f8b068c2e3df3464ecf2"},
  //   {"UserName":"@42d725733741de6ac53cbe3738d8dd2e"}
  // ]
  /**
   * 创建群
   * @param {any} Topic
   * @param {any} MemberList 
   * @returns 
   * @memberof WechatCore
    */
  async createChatroom (Topic, MemberList) {
    let params = {
      'pass_ticket': this.PROP.passTicket,
      'lang': 'zh_CN',
      'r': ~new Date()
    }
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      MemberCount: MemberList.length,
      MemberList: MemberList,
      Topic: Topic
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxcreatechatroom,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 邀请或踢出群成员
   * @param {any} ChatRoomUserName
   * @param {any} MemberList 
   * @param {any} fun 
   * @returns 
   * @memberof WechatCore
   */
  // fun: 'addmember' or 'delmember' or 'invitemember'
  async updateChatroom (ChatRoomUserName, MemberList, fun) {
    let params = {
      fun: fun
    }
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      ChatRoomName: ChatRoomUserName
    }
    if (fun === 'addmember') {
      data.AddMemberList = MemberList.toString()
    } else if (fun === 'delmember') {
      data.DelMemberList = MemberList.toString()
    } else if (fun === 'invitemember') {
      data.InviteMemberList = MemberList.toString()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxupdatechatroom,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  // 置顶或取消置顶
  // OP: 1 联系人置顶 0 取消置顶
  // 若不传RemarkName，则会覆盖以设置的联系人备注名
  async opLog (UserName, OP, RemarkName) {
    let params = {
      pass_ticket: this.PROP.passTicket
    }
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      CmdId: 3,
      OP: OP,
      RemarkName: RemarkName,
      UserName: UserName
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxoplog,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 设置用户标签
   * @param {*} UserName
   * @param {*} RemarkName 
   */
  async updateRemarkName (UserName, RemarkName) {
    let params = {
      pass_ticket: this.PROP.passTicket,
      'lang': 'zh_CN'
    }
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      CmdId: 2,
      RemarkName: RemarkName,
      UserName: UserName
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxoplog,
      params,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  /**
   * 更新群名
   * @param {any} ChatRoomUserName 
   * @param {any} NewName 
   * @memberof WechatCore
   */
  async updateChatRoomName (ChatRoomUserName, NewName) {
    let params = {
      'fun': 'modtopic'
    }
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      ChatRoomName: ChatRoomUserName,
      NewTopic: NewName
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxupdatechatroom,
      params,
      data: paramData
    })
    // console.log(JSON.stringify(res))
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
  }

  // 撤回消息
  async revokeMsg (msgId, toUserName) {
    let paramData = {
      BaseRequest: this.getBaseRequest(),
      SvrMsgId: msgId,
      ToUserName: toUserName,
      ClientMsgId: getClientMsgId()
    }
    const res = await this.request({
      method: 'POST',
      url: this.CONF.API_webwxrevokemsg,
      data: paramData
    })
    const { data } = res
    assert.equal(data.BaseResponse.Ret, 0, res)
    return data
  }

  getBaseRequest () {
    return {
      Uin: parseInt(this.PROP.uin),
      Sid: this.PROP.sid,
      Skey: this.PROP.skey,
      DeviceID: getDeviceID()
    }
  }
}
