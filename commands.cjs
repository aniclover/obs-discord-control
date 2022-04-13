const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { ObsManager } = require('./obs.cjs');
const { Interaction, Channel, Message, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('obs')
    .setDescription('Control OBS (#obs-hub-control only')
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Create new status box'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list_scenes')
        .setDescription('List scenes'))
];

const STATUSBOX_UPDATE_INTERVAL_MS = 10000;
const STATUSBOX_TTL_MS = 24*60*60*1000;

const statusEmbed = new MessageEmbed()
  .setColor('#0099ff')
  .setTitle('OBS Hub Status');

const buttonActionRow = new MessageActionRow()
  .addComponents(
    new MessageButton()
      .setCustomId('upScene')
      .setEmoji('⬆️')
      .setStyle('PRIMARY'),
      new MessageButton()
      .setCustomId('downScene')
      .setEmoji('⬇️')
      .setStyle('PRIMARY')
  )

module.exports.CommandManager = class {
  /** @type {ObsManager} */
  obs = null;
  
  /** @type {Channel} */
  channel = null;

  /** @type {Message} */
  message = null;

  #ready = false;
  
  async #updateStatusTick() {
    if (this.#ready && this.message && this.message.editable) {
      let age = Date.now() - this.message.createdAt;
      if (age > STATUSBOX_TTL_MS) {
        this.#newStatusBox();
        return;
      }
  
      try {
        // await this.message.edit(msgTemplateFn(this.#timestamp(), this.obs))
        this.#updateEmbed();
        await this.message.edit({embeds: [statusEmbed]})
      } catch(err) {
        console.log("Error when updating status: "+err)
        this.#newStatusBox();
      }
    }
  }
  
  async #newStatusBox() {
    this.message = await this.channel.send({embeds: [statusEmbed], components: [buttonActionRow]})
    this.#updateEmbed();
    this.message.edit({embeds: [statusEmbed]})
  }

  #updateEmbed() {
    statusEmbed.setFooter({ text: `Last updated: ${this.#timestamp()}` });
    statusEmbed.setFields(
      // { name: '\u200B', value: '\u200B' },
      { name: 'RTMP Server', value: 'Not yet implemented' },
      // { name: '\u200B', value: '\u200B' },
      { name: 'OBS Hub', value: `Connected: ${this.obs.isConnected}` },
      { name: 'Preview Scene', value: `${this.obs.previewSceneName}\n\`${this.obs.previewSources.map(s=>s.status).join('\n')}\``, inline: true },
      { name: 'Program Scene', value: `${this.obs.programSceneName}\n\`${this.obs.programSources.map(s=>s.status).join('\n')}\``, inline: true }
    )
  }
  
  #timestamp() {
    return new Date().toLocaleString( 'sv', { timeZoneName: 'short' } );
  }


  /**
   * @param {ButtonInteraction} interaction
   */
  async #button(interaction) {
    switch (interaction.customId) {
      case "upScene":
        this.obs.prevPreviewScene();
        break;
      case "downScene":
        this.obs.nextPreviewScene();
        break;
      default:
        console.log("Button click id: "+interaction.customId)
    }

    try {
      await interaction.reply({content: null, ephemeral: true});
    } catch (err) {
      // Expect an error because content is null, so do nothing
    }
  }

  /**
   * @param {Interaction} interaction
   */
  async #command(interaction) {
    if (interaction.commandName === 'obs') {
      switch (interaction.options.getSubcommand()) {
        case "list_scenes":
          let content = "";
          let scenes = await this.obs.fetchSceneList()
          scenes.map((scene) => {
            content += scene.name+"\n"
          })
          interaction.reply(content);
          break;
        case "status":
        default:
          interaction.reply({content: "Creating new status box...", fetchReply: false});
          this.#newStatusBox();  
      }
    }  
  }


  /**
   * @param {Interaction} interaction
   */
  async interact(interaction) {
    if (!this.#ready) {
      return
    }

    if (interaction.isCommand()) {
      this.#command(interaction);
    } else if (interaction.isButton()) {
      this.#button(interaction)
    }
  }

  /**
   * @param {Channel} channel
   */
  ready(channel) {
    this.channel = channel;
    this.#ready = true;
    this.#newStatusBox();
  }

  priorityUpdate() {
    this.#updateStatusTick();
  }

  /**
   * @param nconf
   * @param {ObsManager} obsManager
   */
  constructor(nconf, obsManager) {
    const BOT_TOKEN = nconf.get('discord_bot_token')
    const CLIENT_ID = nconf.get('discord_bot_client_id')
    const GUILD_ID = nconf.get('control_server_id')
  
    const rest = new REST({ version: '9' }).setToken(BOT_TOKEN);

    this.obs = obsManager;
  
    (async () => {
      try {
        console.log('Started refreshing application (/) commands.');
    
        await rest.put(
          Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
          { body: commands },
        );
    
        console.log('Successfully reloaded application (/) commands.');
      } catch (error) {
        console.error(error);
      }
    })();

    setInterval(() => { this.#updateStatusTick() }, STATUSBOX_UPDATE_INTERVAL_MS);
  }
  
}


