const OBSWebSocket = require('obs-websocket-js')

const RECONNECT_INTERVAL_MS = 5000

module.exports.ObsManager = class {
  isConnected = false
  obs = new OBSWebSocket()
  obsAddress = null
  programScene = "unknown"
  previewScene = "unknown"
  priorityUpdateCallback = null

  #reconnectInterval = null
  constructor(obsAddress, priorityUpdateFunc) {
    this.obsAddress = obsAddress
    this.#reconnectInterval = setInterval(() => { this.connectOBS() }, RECONNECT_INTERVAL_MS)
    
    this.obs.on('ConnectionOpened', () => { this.onOBSConnected() })
    this.obs.on('ConnectionClosed', () => { this.onOBSDisconnected() })
    this.obs.on('SwitchScenes', (data) => { this.programScene = data.sceneName ; this.priorityUpdate() })
    this.obs.on('PreviewSceneChanged', (data) => { this.previewScene = data.sceneName; this.priorityUpdate() })
    this.obs.on('error', err => {
      this.onOBSError(err)
    })

    this.priorityUpdateCallback = priorityUpdateFunc
  }

  priorityUpdate() {
    if (this.priorityUpdateCallback != null) {
      this.priorityUpdateCallback()
    }
  }

  initOBS() {
    try {
      this.obs.disconnect()
    } catch (err) {
      // Do nothing
    }

    // this.obs = new OBSWebSocket()
  }

  connectOBS() {
    this.initOBS()

    let secure = false
    let parsedAddress = this.obsAddress
    if (this.obsAddress.startsWith('wss://')) {
      secure = true
      parsedAddress = this.obsAddress.slice(6)
    } else if (this.obsAddress.startsWith('ws://')) {
      secure = false
      parsedAddress = this.obsAddress.slice(5)
    }
    this.obs.connect({ address: parsedAddress, secure })
      .catch(err => {
        // this.onOBSError(err)
        console.log("Error connecting to OBS at "+this.obsAddress)
      })
  }

  disconnectOBS() {
    this.obs.disconnect()
  }

  onOBSError(err) {
    if (err.code === 'CONNECTION_ERROR') {
      this.disconnectOBS()
      this.onOBSDisconnected()
      // this.obsAddressLabel = err.description
    }
    // this.obsConnectionPending = false
    console.error('OBS Websocket Error: ', err)
  }

  async onOBSConnected() {
    clearInterval(this.#reconnectInterval)
    this.isConnected = true

    let programScene = await this.obs.send('GetCurrentScene');
    this.programScene = programScene.name;
    let previewScene = await this.obs.send('GetPreviewScene');
    this.previewScene = previewScene.name;
    this.priorityUpdate();
  }

  async onOBSDisconnected() {
    clearInterval(this.#reconnectInterval)
    if (this.isConnected == true) {
      this.isConnected = false
      this.previewScene = "unknown"
      this.programScene = "unknown"
      this.priorityUpdate();
    }
    this.#reconnectInterval = setInterval(() => { this.connectOBS() }, RECONNECT_INTERVAL_MS)
  }
}