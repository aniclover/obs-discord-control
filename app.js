const nconf = require('nconf')
// const axios = require('axios')

nconf.file({
  file: 'config.yaml',
  format: require('nconf-yaml')
});

const { ObsManager } = require('./obs.cjs')
const obs = new ObsManager(nconf, priorityUpdate)

const { SrsManager } = require('./srs.cjs')
const srs = new SrsManager(nconf.get('srs_server_host'), priorityUpdate)

const { CommandManager } = require('./commands.cjs')
const commands = new CommandManager(nconf, obs, srs)


const { Client, GatewayIntentBits } = require('discord.js')
const BOT_TOKEN = nconf.get('discord_bot_token')
const CHANNEL_ID = nconf.get('control_channel_id')

function priorityUpdate() {
  commands.priorityUpdate();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
