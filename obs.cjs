const OBSWebSocket = require('obs-websocket-js')

const RECONNECT_INTERVAL_MS = 5000

module.exports.ObsManager = class {
  isConnected = false
  obsAddress = null
  programScene = "unknown"
  previewScene = "unknown"
  scenes = []

  obs = new OBSWebSocket()
  #reconnectInterval = null
  #priorityUpdateCallback = null

  async fetchSceneList() {
    if (!this.isConnected) return;

    let data = await this.obs.send('GetSceneList');
    this.scenes = data.scenes;

    return this.scenes;
  }

  async nextPreviewScene() {
    if (!this.isConnected) return;

    let index = this.#findSceneIndex(this.previewScene);
    index++;
    if (index < this.scenes.length) {
      this.obs.send("SetPreviewScene", {'scene-name': this.scenes[index].name});
    }
  }

  async prevPreviewScene() {
    if (!this.isConnected) return;

    let index = this.#findSceneIndex(this.previewScene);
    index--;
    if (index >= 0) {
      this.obs.send("SetPreviewScene", {'scene-name': this.scenes[index].name});
    }
  }

  async transition() {
    if (!this.isConnected) return;

    this.obs.send('TransitionToProgram');
    this.#timetable('advance')
  }

  #timetable (direction) {
    if (direction === 'retract') {
      // this.obs.send('TriggerHotkeyByName', { hotkeyName: 'ROTATE_ccw' })
      this.obs.send('TriggerHotkeyBySequence', { keyId: 'OBS_KEY_NUMASTERISK' })
    } else {
      // this.obs.send('TriggerHotkeyByName', { hotkeyName: 'ROTATE_cw' })
      this.obs.send('TriggerHotkeyBySequence', { keyId: 'OBS_KEY_NUMMINUS' })
    }
  }

  constructor(obsAddress, priorityUpdateFunc) {
    this.obsAddress = obsAddress
    this.#reconnectInterval = setInterval(() => { this.#connectOBS() }, RECONNECT_INTERVAL_MS)
    
    this.obs.on('ConnectionOpened', () => { this.#onOBSConnected() })
    this.obs.on('ConnectionClosed', () => { this.#onOBSDisconnected() })
    this.obs.on('SwitchScenes', (data) => { this.programScene = data.sceneName ; this.#priorityUpdate() })
    this.obs.on('PreviewSceneChanged', (data) => { this.previewScene = data.sceneName; this.#priorityUpdate() })
    this.obs.on('error', err => {
      this.#onOBSError(err)
    })

    this.#priorityUpdateCallback = priorityUpdateFunc
  }

  #priorityUpdate() {
    if (this.#priorityUpdateCallback != null) {
      this.#priorityUpdateCallback()
    }
  }

  #findSceneIndex(sceneName) {
    // console.log(`findScene("${sceneName}")`)
    for (var i = 0; i < this.scenes.length; i++) {
      if (this.scenes[i].name === sceneName) {
        return i
      }
    }
    return -1
  }

  #initOBS() {
    try {
      this.obs.disconnect()
    } catch (err) {
      // Do nothing
    }

    // this.obs = new OBSWebSocket()
  }

  #connectOBS() {
    this.#initOBS()

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

  #disconnectOBS() {
    this.obs.disconnect()
  }

  #onOBSError(err) {
    if (err.code === 'CONNECTION_ERROR') {
      this.#disconnectOBS()
      this.#onOBSDisconnected()
      // this.obsAddressLabel = err.description
    }
    // this.obsConnectionPending = false
    console.error('OBS Websocket Error: ', err)
  }

  async #onOBSConnected() {
    clearInterval(this.#reconnectInterval)
    this.isConnected = true

    this.scenes = this.fetchSceneList();
    let programScene = await this.obs.send('GetCurrentScene');
    this.programScene = programScene.name;
    try {
      let previewScene = await this.obs.send('GetPreviewScene');
      this.previewScene = previewScene.name;  
    } catch (err) {
      console.log(err);
    }
    this.#priorityUpdate();
  }

  async #onOBSDisconnected() {
    clearInterval(this.#reconnectInterval)
    if (this.isConnected == true) {
      this.isConnected = false
      this.previewScene = "unknown"
      this.programScene = "unknown"
      this.#priorityUpdate();
    }
    this.#reconnectInterval = setInterval(() => { this.#connectOBS() }, RECONNECT_INTERVAL_MS)
  }
}