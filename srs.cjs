const axios = require('axios');
const _ = require('lodash');

const RTMP_STAT_UPDATE_INTERVAL_MS = 2000

module.exports.SrsManager = class {

  srsHost = null;
  streams = [];
  streamListMsg = "None";

  #rtmpInterval = null;
  #priorityUpdateCallback = null;
  #srsApiUrl = null;

  #updateRtmpStreams() {
    axios.get(this.#srsApiUrl)
      .then(
        (response) => {
          if (!response.data || !response.data.streams) {
            return;
          }

          let streams = [];
          for (const stream of response.data.streams) {
            if (stream.publish.active !== false) {
              streams.push({
                app: stream.app,
                key: stream.name,
                link: `https://aniclover.com/vlc?url=rtmp://lb.aniclover.com/${stream.app}/${stream.name}`,
                // conns: stream.clients,
                // recv: stream.kbps.recv_30s+"kb/s",
                // video: (stream.video ? `${stream.video.codec}/${stream.video.profile}${stream.video.level}/${stream.video.width}x${stream.video.height}` : ''),
                // audio: (stream.audio ? `${stream.audio.codec}/${stream.audio.sample_rate}/${stream.audio.channel}ch/${stream.audio.profile}` : ''),
                // id: stream.id
              });
            }
          }
          streams = streams.sort(function (a,b) {
            return a.app - b.app;
          });

          if (_.isEqual(streams, this.streams)) {
            // Response is the same as what we last processed, so don't do anything
            return
          }
          this.streams = streams;

          if (this.streams.length < 1) {
            this.streamListMsg = "None"
          } else {
            this.streamListMsg = ""
            for (const stream of this.streams) {
              this.streamListMsg += `[${stream.app}/${stream.key}](${stream.link})\n`
            }  
          }

          this.#priorityUpdate();
        },
        (error) => {
          console.log("Error connecting to SRS RTMP server at "+this.#srsApiUrl)
        }
      )
  }

  #priorityUpdate() {
    if (this.#priorityUpdateCallback === null) {
      return;
    }
    this.#priorityUpdateCallback()
  }

  constructor(srsHost, priorityUpdateFunc) {
    this.srsHost = srsHost;
    this.#priorityUpdateCallback = priorityUpdateFunc

    this.#srsApiUrl = `http://${srsHost}/api/v1/streams/`

    this.#rtmpInterval = setInterval( () => { this.#updateRtmpStreams() }, RTMP_STAT_UPDATE_INTERVAL_MS)
  }

}