const OBSWebSocket = require('obs-websocket-js').default

const RECONNECT_INTERVAL_MS = 5000

const MIN_PRIORITY_UPDATE_INTERVAL_MS = 1000;

const NUDGE_DB = 0.5;

const MUTE_DB = -80;

module.exports.ObsManager = class {
  isConnected = false
  obsAddress = null
  programSceneName = "unknown"
  previewSceneName = "unknown"
  programSceneIndex = -1
  previewSceneIndex = -1
  programSources = []
  previewSources = []
  rtmpAllSources = []
  rtmpAllMap = {}
  scenes = []
  transitionTargetDB = -10;
  transitionCrossfadeDurationSecs = 10;
  transitionVisualDelaySecs = 5;

  obs = new OBSWebSocket()
  #reconnectInterval = null
  #priorityUpdateCallback = null
  #priorityUpdateTimeout = null
  #lastPriorityUpdateTS = 0
  #ttTransitionDirection = "none"

  async fetchSceneList() {
    if (!this.isConnected) return;

    let data = await this.obs.call('GetSceneList');
    this.scenes = data.scenes;

    return this.scenes;
  }

  async nextPreviewScene() {
    if (!this.isConnected) return;

    let index = this.previewSceneIndex;
    index++;
    if (index < this.scenes.length) {
      this.obs.call("SetCurrentPreviewScene", {sceneName: this.scenes[index].sceneName});
    }
  }

  async prevPreviewScene() {
    if (!this.isConnected) return;

    let index = this.previewSceneIndex;
    index--;
    if (index >= 0) {
      this.obs.call("SetCurrentPreviewScene", {sceneName: this.scenes[index].sceneName});
    }
  }

  async setPreviewSourceVolume(dB) {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#changeDB(this.previewSources[0].sourceName, dB)
    this.transitionTargetDB = dB;
  }

  async mutePreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#setMute(this.previewSources[0].sourceName, true)
  }

  async unmutePreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#setMute(this.previewSources[0].sourceName, false)
  }

  async playPausePreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#togglePlayPause(this.previewSources[0].sourceName)
  }

  async playPauseProgramSource() {
    if (!this.isConnected || this.programSources.length < 1) return;

    this.#togglePlayPause(this.programSources[0].sourceName)
  }

  async reloadPreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#reloadSource(this.previewSources[0].sourceName);
  }

  async reloadProgramSource() {
    if (!this.isConnected || this.programSources.length < 1) return;

    this.#reloadSource(this.programSources[0].sourceName);
  }

  async retransformPreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    let sceneName = this.previewSceneName;
    let sceneItemName = this.previewSources[0].sourceName;
    let sceneItemId = this.previewSources[0].sceneItemId;
    console.log(`GetSceneItemProperties: ${sceneName} / ${sceneItemName}`);

    let properties = await this.obs.call('GetSceneItemTransform', { sceneName: sceneName, sceneItemId: sceneItemId });
    // console.log(properties);

    let width = properties.sceneItemTransform.sourceWidth;
    let height = properties.sceneItemTransform.sourceHeight;
    let scale = 1;

    if (Math.abs(1920 - width) < Math.abs(1080 - height)) {
      // Width needs less scaling, so scale to width
      scale = 1920.0 / width;
    } else {
      // Height needs less scaling, so scale to height
      scale = 1080.0 / height;
    }

    let newProps = { }
    newProps.positionX = 1920/2;
    newProps.positionY = 1080/2;
    newProps.alignment = 0;
    newProps.scaleX = scale;
    newProps.scaleY = scale;
    // newProps.width = width*scale;
    // newProps.height = height*scale;
    console.log(newProps)
    
    this.obs.call('SetSceneItemTransform', {sceneName: sceneName, sceneItemId: sceneItemId, sceneItemTransform: newProps });
  }

  async transition() {
    if (!this.isConnected) return;


    if (this.previewSources.length > 0) {
      let previewSource = this.previewSources[0];
      // console.log("Transition to: ")
      // console.log(previewSource)

      if (previewSource.isLocal) {
        this.#playSource(previewSource.sourceName);
      }
    }

    // Crossfade audio in NUDGE_DB increments to transitionTargetDB over transitionCrossfadeDurationSecs
    this.#crossfadeTransitionToTarget();

    // Delay by tansitionVisualDelaySecs before triggering OBS transition
    setTimeout( () => {
      this.obs.call('TriggerStudioModeTransition');
      this.ttAdvance();
    }, this.transitionVisualDelaySecs*1000)
  }

  async ttAdvance() {
    if (!this.isConnected) return;

    if (this.#ttTransitionDirection === 'advance') {
      this.#timetable('advance')  
    } else if (this.#ttTransitionDirection === 'retract') {
      this.#timetable('retract')
    }
  }

  async ttRetract() {
    if (!this.isConnected) return;
    if (this.#ttTransitionDirection === 'advance') {
      this.#timetable('retract')  
    } else if (this.#ttTransitionDirection === 'retract') {
      this.#timetable('advance')
    }
  }

  async nudgeProgramSofter() {
    if (!this.isConnected) return;

    this.#changeDeltaProgramDB(-NUDGE_DB)
  }

  async nudgeProgramLouder() {
    if (!this.isConnected) return;

    this.#changeDeltaProgramDB(NUDGE_DB)
  }

  async nudgePreviewSofter() {
    if (!this.isConnected) return;

    this.#changeDeltaPreviewDB(-NUDGE_DB)
    this.transitionTargetDB -= NUDGE_DB
  }

  async nudgePreviewLouder() {
    if (!this.isConnected) return;

    this.#changeDeltaPreviewDB(NUDGE_DB)
    this.transitionTargetDB += NUDGE_DB
  }

  async #togglePlayPause(sourceName) {
    const data = await this.obs.call("GetMediaInputStatus", {inputName: sourceName});
    if (data.mediaState == "OBS_MEDIA_STATE_PLAYING") {
      this.obs.call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE" })
    } else {
      this.obs.call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY" })
    }
  }

  async #crossfadeTransitionToTarget() {
    if (!this.isConnected || this.programSources.length < 1 || this.previewSources.length < 1) return;

    const programSource = this.programSources[0]
    const previewSource = this.previewSources[0]

    if (previewSource.muted) {
      await this.#changeDB(previewSource.sourceName, MUTE_DB)
      previewSource.dB = MUTE_DB
      await this.#setMute(previewSource.sourceName, false)
    }

    if (previewSource.dB > this.transitionTargetDB) {
      console.log(`Crossfade requested, but source ${previewSource.sourceName} is already louder than ${this.transitionTargetDB}. Ignoring...`)
      return;
    }

    if (programSource.dB < MUTE_DB) {
      console.log(`Crossfade requested, but source ${programSource.sourceName} is already softer than mute threshold of ${this.MUTE_DB}. Ignoring...`)
    }

    // Preview source always nudges up
    let previewNudgeIterations = Math.round((this.transitionTargetDB - previewSource.dB)/NUDGE_DB)

    // Program sources always nudges down
    let programNudgeIterations = Math.round((programSource.dB - MUTE_DB)/NUDGE_DB)

    const previewNudgeIntervalMs = (this.transitionCrossfadeDurationSecs*1000)/previewNudgeIterations;
    const programNudgeIntervalMs = (this.transitionCrossfadeDurationSecs*1000)/programNudgeIterations;
    console.log(`Crossfade: ${previewNudgeIterations} nudges of ${previewSource.sourceName}, ${programNudgeIterations} of ${programSource.sourceName}`)

    // Need separate copies of these to keep track consistently through updates coming back
    // from OBS as volume changes
    let previewDB = previewSource.dB;
    let programDB = programSource.dB;

    if (previewNudgeIterations > 0) {
      let previewInterval = setInterval( async () => {
        previewDB += NUDGE_DB;
        this.#changeDB(previewSource.sourceName, previewDB)
        if (--previewNudgeIterations <= 0) {
          clearInterval(previewInterval)
        }
      }, previewNudgeIntervalMs)
    }

    if (programNudgeIterations > 0) {
      let programInterval = setInterval( async () => {
        programDB -= NUDGE_DB;
        this.#changeDB(programSource.sourceName, programDB);
        if (--programNudgeIterations <= 0) {
          await this.#setMute(programSource.sourceName, true)
          await this.#changeDB(programSource.sourceName, 0)
          clearInterval(programInterval)
        }
      }, programNudgeIntervalMs)
    }
  }

  async #reloadSource(sourceName) {
    let data = await this.obs.call('GetInputSettings', { inputName: sourceName })
    this.obs.call('SetInputSettings', {
      inputName: sourceName,
      inputSettings: data.inputSettings
    })
  }

  async #setMute(sourceName, isMuted) {
    await this.obs.call("SetInputMute", { inputName: sourceName, inputMuted: isMuted })
  }
  
  async #changeDeltaProgramDB(deltaDB) {
    if (this.programSources.length < 1) return;
    let source = this.programSources[0];
    source.dB += deltaDB;

    await this.#changeDB(source.sourceName, source.dB)
  }

  async #changeDeltaPreviewDB(deltaDB) {
    if (this.previewSources.length < 1) return;
    let source = this.previewSources[0];
    source.dB += deltaDB;

    await this.#changeDB(source.sourceName, source.dB)
  }

  async #playSource(sourceName) {
    // console.log("#playSource: "+sourceName)
    await this.obs.call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY"})
  }

  async #changeDB(sourceName, newDB) {
    await this.obs.call('SetInputVolume', { inputName: sourceName, inputVolumeDb: newDB })
  }

  #timetable (direction) {
    if (direction === 'retract') {
      // this.obs.call('TriggerHotkeyByName', { hotkeyName: 'ROTATE_ccw' })
      this.obs.call('TriggerHotkeyByKeySequence', { keyId: 'OBS_KEY_NUMASTERISK' })
    } else {
      // this.obs.call('TriggerHotkeyByName', { hotkeyName: 'ROTATE_cw' })
      this.obs.call('TriggerHotkeyByKeySequence', { keyId: 'OBS_KEY_NUMMINUS' })
    }
  }

  constructor(nconf, priorityUpdateFunc) {
    this.obsAddress = nconf.get('obs_hub_ws_address')

    this.#ttTransitionDirection = nconf.get('tt_transition_direction')
    this.#reconnectInterval = setInterval(() => { this.#connectOBS() }, RECONNECT_INTERVAL_MS)
    
    // this.obs.on('ConnectionOpened', () => { this.#onOBSConnected() })
    this.obs.on('ConnectionClosed', () => { this.#onOBSDisconnected() })
    this.obs.on('CurrentProgramSceneChanged', async (data) => {
      await this.#updateProgramScene(data.sceneName);
      this.#priorityUpdate();
    })
    this.obs.on('CurrentPreviewSceneChanged', async (data) => {
      await this.#updatePreviewScene(data.sceneName)
      this.#priorityUpdate()
    })
    this.obs.on('InputVolumeChanged', (data) => {
      if (this.previewSources.length > 0 && data.inputName === this.previewSources[0].sourceName) {
        this.previewSources[0].dB = data.inputVolumeDb;
        this.previewSources[0].status = this.#makeSourceStatus(this.previewSources[0])
      } else if (this.programSources.length > 0 && data.inputName === this.programSources[0].sourceName) {
        this.programSources[0].dB = data.inputVolumeDb;
        this.programSources[0].status = this.#makeSourceStatus(this.programSources[0])
      } else {
        return;
      }
      this.#priorityUpdate()
    })
    this.obs.on('InputMuteStateChanged', (data) => {
      if (this.previewSources.length > 0 && data.inputName === this.previewSources[0].sourceName) {
        this.previewSources[0].muted = data.inputMuted;
        this.previewSources[0].status = this.#makeSourceStatus(this.previewSources[0])
      } else if (this.programSources.length > 0 && data.inputName === this.programSources[0].sourceName) {
        this.programSources[0].muted = data.inputMuted;
        this.programSources[0].status = this.#makeSourceStatus(this.programSources[0])
      } else {
        return;
      }
      this.#priorityUpdate()
    })
    // this.obs.on('error', err => {
    //   this.#onOBSError(err)
    // })

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
      console.log("Immediate priority update at "+this.#lastPriorityUpdateTS);
    } else {
      this.#priorityUpdateTimeout = setTimeout( async () => {
        this.#priorityUpdateCallback();
        this.#lastPriorityUpdateTS = Date.now();
        console.log("Delayed priority update at "+this.#lastPriorityUpdateTS);
      }, MIN_PRIORITY_UPDATE_INTERVAL_MS)
    }
  }

  #findSceneIndex(sceneName) {
    // console.log(`findScene("${sceneName}")`)
    for (var i = 0; i < this.scenes.length; i++) {
      if (this.scenes[i].sceneName === sceneName) {
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

    let parsedAddress = this.obsAddress

    this.obs.connect( parsedAddress )
      .then( () => {
        this.#onOBSConnected();
      })
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
    this.#syncRtmpAll();
  }

  async #updatePreviewScene(name) {
    this.previewSceneName = name;
    this.previewSceneIndex = this.#findSceneIndex(name);

    this.previewSources = await this.#fetchSources(name);

    if (this.previewSources.length > 0 && this.previewSources[0]) {
      this.transitionTargetDB = this.previewSources[0].dB;
    }
    this.#syncRtmpAll();
  }

  async #syncRtmpAll() {
    const trackMap = new Map(this.rtmpAllMap);

    for (const s of this.programSources.concat(this.previewSources)) {
      const rs = trackMap.get(s.sourceName)
      if (rs) {
        trackMap.delete(s.sourceName)
        await this.obs.call('SetSceneItemEnabled', {sceneName: "RTMP All", sceneItemId: rs.sceneItemId, sceneItemEnabled: true})
      }
    }

    for (const rs of trackMap.values()) {
      await this.obs.call('SetSceneItemEnabled', {sceneName: "RTMP All", sceneItemId: rs.sceneItemId, sceneItemEnabled: false})
    }
  }

  async #fetchSources(sceneName) {
    let response = await this.obs.call('GetSceneItemList', {sceneName: sceneName});
    let sources = response.sceneItems.filter(s => s.inputKind==="ffmpeg_source");
    for (const s of sources) {
      let volData = await this.obs.call('GetInputVolume', {inputName: s.sourceName})
      let muteData = await this.obs.call('GetInputMute', {inputName: s.sourceName})
      let sourceSettings = await this.obs.call('GetInputSettings', {inputName: s.sourceName});
      // console.log(sourceSettings);

      s.dB = volData.inputVolumeDb;
      s.muted = muteData.inputMuted;
      s.status = this.#makeSourceStatus(s)
      s.isLocal = sourceSettings.inputSettings.is_local_file
    }
    return sources;
  }

  #makeSourceStatus(s) {
    return `${s.sourceName}\n${s.dB.toFixed(1)} dB\n${s.muted?"Muted":"Unmuted"}`
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
    for (const scene of this.scenes) {
      if (scene.sceneName == "RTMP All") {
        this.rtmpAllSources = await this.#fetchSources(scene.sceneName);
        console.log("Fetched RTMP All sources. Count: "+this.rtmpAllSources.length)
        this.rtmpAllMap = new Map(this.rtmpAllSources.map((s) => [s.sourceName, s]));
        for (const s of this.rtmpAllSources) {
          // console.log(s)
          await this.obs.call('SetSceneItemEnabled', {sceneName: "RTMP All", sceneItemId: s.sceneItemId, sceneItemEnabled: false});
        }
      }
    }
    let programScene = await this.obs.call('GetCurrentProgramScene');
    await this.#updateProgramScene(programScene.currentProgramSceneName)
    try {
      let previewScene = await this.obs.call('GetCurrentPreviewScene');
      await this.#updatePreviewScene(previewScene.currentPreviewSceneName)
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