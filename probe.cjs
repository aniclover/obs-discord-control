const OBSWebSocket = require('obs-websocket-js').default

const obs = new OBSWebSocket();


async function main() {
  await obs.connect('ws://localhost:4455')

  const sceneName = "4 - chiii"

  let sceneListData = await obs.call('GetSceneList');
  console.log(sceneListData)

  let sceneData = await obs.call('GetSceneItemList', {sceneName: sceneName})
  console.log(sceneData)

  transformData = await obs.call('GetSceneItemTransform', {sceneName: sceneName, sceneItemId: sceneData.sceneItems[0].sceneItemId})
  console.log(transformData)

  sceneSettingsData = await obs.call('GetInputSettings', { inputName: sceneData.sceneItems[0].sourceName})
  console.log(sceneSettingsData)

  obs.disconnect()
}

main()