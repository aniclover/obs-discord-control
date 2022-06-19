const OBSWebSocket = require('obs-websocket-js')

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
  scenes = []
  transitionTargetDB = -10;
  transitionCrossfadeDurationSecs = 10;
  transitionVisualDelaySecs = 5;

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

    this.obs.send('PlayPauseMedia', { sourceName: this.previewSources[0].sourceName });
  }

  async playPauseProgramSource() {
    if (!this.isConnected || this.programSources.length < 1) return;

    this.obs.send('PlayPauseMedia', { sourceName: this.programSources[0].sourceName });
  }

  async reloadPreviewSource() {
    if (!this.isConnected || this.previewSources.length < 1) return;

    this.#reloadSource(this.previewSources[0].sourceName);
  }

  async reloadProgramSource() {
    if (!this.isConnected || this.programSources.length < 1) return;

    this.#reloadSource(this.programSources[0].sourceName);
  }

  async transition() {
    if (!this.isConnected) return;

    if (this.previewSources.length > 0) {
      let previewSource = this.previewSources[0];
      if (previewSource.isLocal) {
        this.#playSource(previewSource.sourceName);
      }
    }

    // Crossfade audio in NUDGE_DB increments to transitionTargetDB over transitionCrossfadeDurationSecs
    this.#crossfadeTransitionToTarget();

    // Delay by tansitionVisualDelaySecs before triggering OBS transition
    setTimeout( () => {
      this.obs.send('TransitionToProgram');
      this.#timetable('advance')  
    }, this.transitionVisualDelaySecs*1000)
  }

  async ttAdvance() {
    if (!this.isConnected) return;

    this.#timetable('advance')
  }

  async ttRetract() {
    if (!this.isConnected) return;

    this.#timetable('retract')
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
    let data = await this.obs.send('GetSourceSettings', { sourceName: sourceName })
    this.obs.send('SetSourceSettings', {
      sourceName: sourceName,
      sourceSettings: data.sourceSettings
    })
  }

  async #setMute(sourceName, isMuted) {
    await this.obs.send("SetMute", { source: sourceName, mute: isMuted })
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
    await this.obs.send("PlayPauseMedia", {sourceName: sourceName, playPause:false})
  }

  async #changeDB(sourceName, newDB) {
    await this.obs.send('SetVolume', { source: sourceName, volume: newDB, useDecibel: true})
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
    this.obs.on('SourceVolumeChanged', (data) => {
      if (this.previewSources.length > 0 && data.sourceName === this.previewSources[0].sourceName) {
        this.previewSources[0].dB = data.volumeDb;
        this.previewSources[0].status = this.#makeSourceStatus(this.previewSources[0])
      } else if (this.programSources.length > 0 && data.sourceName === this.programSources[0].sourceName) {
        this.programSources[0].dB = data.volumeDb;
        this.programSources[0].status = this.#makeSourceStatus(this.programSources[0])
      } else {
        return;
      }
      this.#priorityUpdate()
    })
    this.obs.on('SourceMuteStateChanged', (data) => {
      if (this.previewSources.length > 0 && data.sourceName === this.previewSources[0].sourceName) {
        this.previewSources[0].muted = data.muted;
        this.previewSources[0].status = this.#makeSourceStatus(this.previewSources[0])
      } else if (this.programSources.length > 0 && data.sourceName === this.programSources[0].sourceName) {
        this.programSources[0].muted = data.muted;
        this.programSources[0].status = this.#makeSourceStatus(this.programSources[0])
      } else {
        return;
      }
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

    this.previewSources = await this.#fetchSources(name);

    if (this.previewSources.length > 0 && this.previewSources[0]) {
      this.transitionTargetDB = this.previewSources[0].dB;
    }
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
      s.status = this.#makeSourceStatus(s)
      s.isLocal = sourceSettings.is_local_file
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