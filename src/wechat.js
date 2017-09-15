import WechatCore from './core'
import EventEmitter from 'events'
const qrcode = require('qrcode-terminal')
import _ from 'lodash'
import {
  getCONF,
  isStandardBrowserEnv
} from './util'
import ContactFactory from './interface/contact'
import MessageFactory from './interface/message'
import _debug from 'debug'
const debug = _debug('wechat')

if (!isStandardBrowserEnv) {
  process.on('uncaughtException', err => {
    console.log('uncaughtException', err)
  })
}

class Wechat extends WechatCore {

  constructor (hotReload = true) {
    super(hotReload)
    _.extend(this, new EventEmitter())
    this.state = this.CONF.STATE.init
    this.contacts = {} // 所有联系人
    this.groupList = []
    this.Contact = ContactFactory(this)
    this.Message = MessageFactory(this)
    this.lastSyncTime = 0
    this.syncPollingId = 0
    this.syncErrorCount = 0
    this.checkPollingId = 0
    this.retryPollingId = 0
  }

  get friendList () {
    let members = []
    for (let key in this.contacts) {
      let member = this.contacts[key]
      members.push({
        username: member['UserName'],
        nickname: this.Contact.getDisplayName(member),
        py: member['RemarkPYQuanPin'] ? member['RemarkPYQuanPin'] : member['PYQuanPin'],
        avatar: member.AvatarUrl
      })
    }

    return members
  }

  async sendMsg (msg, toUserName) {
    if (typeof msg !== 'object') {
      return await this.sendText(msg, toUserName)
    } else if (msg.emoticonMd5) {
      return await this.sendEmoticon(msg.emoticonMd5, toUserName)
    } else {
      const res = await this.uploadMedia(msg.file, msg.filename, toUserName)
      switch (res.ext) {
        case 'bmp':
        case 'jpeg':
        case 'jpg':
        case 'png':
          return await this.sendPic(res.mediaId, toUserName)
        case 'gif':
          return await this.sendEmoticon(res.mediaId, toUserName)
        case 'mp4':
          return await this.sendVideo(res.mediaId, toUserName)
        default:
          return await this.sendDoc(res.mediaId, res.name, res.size, res.ext, toUserName)
      }
    }
  }

  async syncPolling (id = ++this.syncPollingId) {
    if (this.state !== this.CONF.STATE.login || this.syncPollingId !== id) {
      return
    }
    try {
      const selector = await this.syncCheck()
      debug('Sync Check Selector: ', selector)
      if (+selector !== this.CONF.SYNCCHECK_SELECTOR_NORMAL) {
        const data = await this.sync()
        this.syncErrorCount = 0
        await this.handleSync(data)
      }
      this.lastSyncTime = Date.now()
      await this.syncPolling(id)
    } catch (err) {
      if (this.state !== this.CONF.STATE.login) {
        return
      }
      debug(err)
      this.emit('error', err)
      if (++this.syncErrorCount > 2) {
        let err = new Error(`连续${this.syncErrorCount}次同步失败，5s后尝试重启`)
        debug(err)
        this.emit('error', err)
        clearTimeout(this.retryPollingId)
        setTimeout(() => this.restart(), 5 * 1000)
        return
      }
      clearTimeout(this.retryPollingId)
      this.retryPollingId = setTimeout(() => this.syncPolling(id), 2000 * this.syncErrorCount)
    }
  }

  async _getContact(Seq = 0) {
    let contacts = []
    try {
      const res = await this.getContact(Seq)
      contacts = res.MemberList || []
      // 查看seq是否为0，0表示好友列表已全部获取完毕，若大于0，则表示好友列表未获取完毕，当前的字节数（断点续传）
      if (res.Seq) {
        const _contacts = await this._getContact(res.Seq)
        contacts = contacts.concat(_contacts || [])
        return contacts
      }
      if (Seq === 0) {
        let emptyGroup = contacts.filter(contact => contact.UserName.startsWith('@@') && contact.MemberCount === 0) || []
        if (emptyGroup.length !== 0) {
          const _contacts = await this.batchGetContact(emptyGroup)
          contacts = contacts.concat(_contacts || [])
        }
      }
      return contacts
    } catch (err) {
      this.emit('error', err)
      return contacts
    }
  }

  async _init () {
    const data = await this.init()
    // this.getContact() 这个接口返回通讯录中的联系人（包括已保存的群聊）
    // 临时的群聊会话在初始化的接口中可以获取，因此这里也需要更新一遍 contacts
    // 否则后面可能会拿不到某个临时群聊的信息
    this.updateContacts(data.ContactList)
    try {
      debug('开启微信状态通知')
      await this.notifyMobile()
    } catch (err) {
      this.emit('error', err)
    }
    const contacts = await this._getContact()
    debug('getContact count: ', contacts.length)
    this.updateContacts(contacts)
    this.state = this.CONF.STATE.login
    this.lastSyncTime = Date.now()
    await this.syncPolling()
    await this.checkPolling()
    this.emit('login')
  }

  async _login () {
    const handlerQRLogin = async () => {
      const res = await this.checkLogin()
      if (res.code === 201 && res.userAvatar) {
        this.emit('user-avatar', res.userAvatar)
      }
      if (res.code !== 200) {
        if (res.code === 401) {
          console.log('请扫描二维码')
        } else if (res.code === 201) {
          console.log('请点击微信确认按钮，进行登陆')
        } else {
          debug('handlerQRLogin => ', res.code)
        }
        return await handlerQRLogin()
      }
      return res
    }
    try {
      const uuid = await this.getUUID()
      debug('getUUID: ', uuid)
      this.emit('uuid', uuid)
      console.log('请扫描二维码登录')
      qrcode.generate(this.CONF.API_base_login + uuid, {
        small: true
      })
      this.state = this.CONF.STATE.uuid
      const res = await handlerQRLogin()
      debug('handlerQRLogin: ', res.redirect_uri)
      return await this.login()
    } catch (err) {
      debug(err)
      console.log('微信登陆异常:', err.message)
    }
  }

  async start () {
    try {
      debug('启动中...')
      await this._login()
      await this._init()
    } catch (err) {
      debug(err)
      this.emit('error', err)
      this.stop()
    }
  }

  async restart () {
    try {
      debug('重启中...')
      await this._init()
    } catch (err) {
      if (err.response) {
        throw err
      }
      debug(err.message)
      let err = new Error('重启时网络错误，60s后进行最后一次重启')
      this.emit('error', err)
      await new Promise(resolve => {
        setTimeout(resolve, 60 * 1000)
      })
      try {
        const data = await this.init()
        this.updateContacts(data.ContactList)
      } catch (err) {
        debug(err)
        this.emit('error', err)
        await this.stop()
      }
    }
  }

  async stop () {
    debug('登出中...')
    clearTimeout(this.retryPollingId)
    clearTimeout(this.checkPollingId)
    await this.logout()
    this.state = this.CONF.STATE.logout
    this.emit('logout')
  }

  /**
   * 检测状态并发送心跳
   * @memberof Wechat
   */
  async checkPolling () {
    if (this.state !== this.CONF.STATE.login) {
      return
    }
    let interval = Date.now() - this.lastSyncTime
    if (interval > 1 * 60 * 1000) {
      let err = new Error(`状态同步超过${interval / 1000}s未响应，5s后尝试重启`)
      debug(err)
      this.emit('error', err)
      clearTimeout(this.checkPollingId)
      setTimeout(() => this.restart(), 5 * 1000)
    } else {
      debug('发送心跳')
      try {
        await this.notifyMobile()
        await this.sendMsg(this._getPollingMessage(), this._getPollingTarget())
      } catch (err) {
        debug(err)
        this.emit('error', err)
      }
      clearTimeout(this.checkPollingId)
      this.checkPollingId = setTimeout(() => this.checkPolling(), this._getPollingInterval())
    }
  }

  async handleSync (data) {
    if (!data) {
      await this.restart()
      return
    }
    if (data.AddMsgCount) {
      debug('syncPolling messages count: ', data.AddMsgCount)
      await this.handleMsg(data.AddMsgList)
    }
    if (data.ModContactCount) {
      debug('syncPolling ModContactList count: ', data.ModContactCount)
      this.updateContacts(data.ModContactList)
    }
  }

  async handleMsg (data) {
    try {
      for (let msg of data) {
        if (!this.contacts[msg.FromUserName] ||
          (msg.FromUserName.startsWith('@@') &&
          this.contacts[msg.FromUserName].MemberCount === 0)) {
          let contacts = await this.batchGetContact([{ UserName: msg.FromUserName, EncryChatRoomId: '' }])
          this.updateContacts(contacts)
        }
        msg = this.Message.extend(msg)
        this.emit('message', msg)
        if (msg.MsgType === this.CONF.MSGTYPE_STATUSNOTIFY) {
          let userList = msg.StatusNotifyUserName.split(',')
          .filter(UserName => !this.contacts[UserName])
          .map(UserName => {
            return { UserName: UserName, EncryChatRoomId: '' }
          })
          for (let list of _.chunk(userList, 50)) {
            let contacts = await this.batchGetContact(list)
            debug('batchGetContact data length: ', contacts.length)
            this.updateContacts(contacts)
          }
        }
        if (msg.ToUserName === 'filehelper' && msg.Content === '退出wechat4u' ||
          /^(.\udf1a\u0020\ud83c.){3}$/.test(msg.Content)) {
          await this.stop()
        }
      } // end for
    } catch (err) {
      this.emit('error', err)
      debug(err)
    }
  }

  /**
   * 更新联系人
   * @param {any} contacts 
   * @memberof Wechat
   */
  updateContacts (contacts) {
    if (!contacts || contacts.length === 0) {
      return
    }
    contacts.forEach(contact => {
      if (this.contacts[contact.UserName]) {
        let oldContact = this.contacts[contact.UserName]
        // 清除无效的字段
        for (let i in contact) {
          contact[i] || delete contact[i]
        }
        Object.assign(oldContact, contact)
        this.Contact.extend(oldContact)
      } else {
        this.contacts[contact.UserName] = this.Contact.extend(contact)
      }
    })
    this.emit('contacts-updated', contacts)
  }

  _getPollingMessage () { // Default polling message
    return '心跳：' + new Date().toLocaleString()
  }

  _getPollingInterval () { // Default polling interval
    return 5 * 60 * 1000
  }

  _getPollingTarget () { // Default polling target user
    return 'filehelper'
  }

  setPollingMessageGetter (func) {
    if (typeof (func) !== 'function') return
    if (typeof (func()) !== 'string') return
    this._getPollingMessage = func
  }

  setPollingIntervalGetter (func) {
    if (typeof (func) !== 'function') return
    if (typeof (func()) !== 'number') return
    this._getPollingInterval = func
  }

  setPollingTargetGetter (func) {
    if (typeof (func) !== 'function') return
    if (typeof (func()) !== 'string') return
    this._getPollingTarget = func
  }

}

Wechat.STATE = getCONF().STATE

exports = module.exports = Wechat
