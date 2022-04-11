const nconf = require('nconf')
const axios = require('axios')

nconf.file({
  file: 'config.yaml',
  format: require('nconf-yaml')
});

const { ObsManager } = require('./obs.cjs')
const obs = new ObsManager(nconf.get('obs_hub_ws_address'), priorityUpdate)

const { CommandManager } = require('./commands.cjs')
const commands = new CommandManager(nconf, obs)


const { Client, Intents } = require('discord.js')
const client = new Client({ intents: [Intents.FLAGS.GUILDS] });
const BOT_TOKEN = nconf.get('discord_bot_token')
const CHANNEL_ID = nconf.get('control_channel_id')

function priorityUpdate() {
  commands.priorityUpdate();
}

client.on('ready', async () => {
  let channel = await client.channels.fetch(CHANNEL_ID)
  console.log(`Logged in as ${client.user.tag}!`);
  commands.ready(channel)
});

client.on('interactionCreate', async interaction => {
  if (interaction.channelId !== CHANNEL_ID) {
    return;
  }

  commands.interact(interaction);
});

client.login(BOT_TOKEN)
