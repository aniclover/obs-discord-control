const OBSWebSocket = require('obs-websocket-js')

const RECONNECT_INTERVAL_MS = 5000

const MIN_PRIORITY_UPDATE_INTERVAL_MS = 1000;

module.exports.ObsManager = class {
  isConnected = false
  obsAddress = null
  programSceneName = "unknown"
  previewSceneName = "unknown"
  programSceneIndex = -1
  previewSceneIndex = -1
  programSources = []
  previewSources = []
  scenes = []

  obs = new OBSWebSocket()
  #reconnectInterval = null
  #priorityUpdateCallback = null
  #priorityUpdateTimeout = null
  #lastPriorityUpdateTS = 0

  async fetchSceneList() {
    if (!this.isConnected) return;

    let data = await this.obs.send('GetSceneList');
    this.scenes = data.scenes;

    return this.scenes;
  }

  async nextPreviewScene() {
    if (!this.isConnected) return;

    let index = this.previewSceneIndex;
    index++;
    if (index < this.scenes.length) {
      this.obs.send("SetPreviewScene", {'scene-name': this.scenes[index].name});
    }
  }

  async prevPreviewScene() {
    if (!this.isConnected) return;

    let index = this.previewSceneIndex;
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
    this.obs.on('SwitchScenes', async (data) => {
      await this.#updateProgramScene(data.sceneName);
      this.#priorityUpdate();
    })
    this.obs.on('PreviewSceneChanged', async (data) => {
      await this.#updatePreviewScene(data.sceneName)
      this.#priorityUpdate()
    })
    this.obs.on('error', err => {
      this.#onOBSError(err)
    })

    this.#priorityUpdateCallback = priorityUpdateFunc
  }

  #priorityUpdate() {
    if (this.#priorityUpdateCallback === null) {
      return;
    }

    clearTimeout(this.#priorityUpdateTimeout);
    this.#priorityUpdateTimeout = null;

    let nowTS = Date.now();
    if (nowTS - this.#lastPriorityUpdateTS > MIN_PRIORITY_UPDATE_INTERVAL_MS) {
      this.#priorityUpdateCallback();
      this.#lastPriorityUpdateTS = nowTS;
      // console.log("Immediate priority update at "+this.#lastPriorityUpdateTS);
    } else {
      this.#priorityUpdateTimeout = setTimeout( async () => {
        this.#priorityUpdateCallback();
        this.#lastPriorityUpdateTS = Date.now();
        // console.log("Delayed priority update at "+this.#lastPriorityUpdateTS);
      }, MIN_PRIORITY_UPDATE_INTERVAL_MS)
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

  async #updateProgramScene(name) {
    this.programSceneName = name;
    this.programSceneIndex = this.#findSceneIndex(name)

    this.programSources = await this.#fetchSources(name);
  }

  async #updatePreviewScene(name) {
    this.previewSceneName = name;
    this.previewSceneIndex = this.#findSceneIndex(name);

    this.previewSources = await this.#fetchSources(name)
  }

  async #fetchSources(sceneName) {
    let response = await this.obs.send('GetSceneItemList', {sceneName: sceneName});
    let sources = response.sceneItems.filter(s => s.sourceKind==="ffmpeg_source");
    for (const s of sources) {
      let vol = await this.obs.send('GetVolume', {source: s.sourceName, useDecibel: true})
      let {sourceSettings} = await this.obs.send('GetSourceSettings', {sourceName: s.sourceName});
      // console.log(sourceSettings);

      s.dB = vol.volume;
      s.muted = vol.muted;
      s.status = `${s.sourceName}\n${s.dB.toFixed(1)} dB\n${s.muted?"Muted":"Unmuted"}`
    }
    return sources;
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

    this.scenes = await this.fetchSceneList();
    let programScene = await this.obs.send('GetCurrentScene');
    await this.#updateProgramScene(programScene.name)
    try {
      let previewScene = await this.obs.send('GetPreviewScene');
      await this.#updatePreviewScene(previewScene.name)
    } catch (err) {
      console.log(err);
    }
    this.#priorityUpdate();
  }

  async #onOBSDisconnected() {
    clearInterval(this.#reconnectInterval)
    if (this.isConnected == true) {
      this.isConnected = false
      this.previewSceneName = "unknown"
      this.programSceneName = "unknown"
      this.#priorityUpdate();
    }
    this.#reconnectInterval = setInterval(() => { this.#connectOBS() }, RECONNECT_INTERVAL_MS)
  }
}