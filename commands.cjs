const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { ObsManager } = require('./obs.cjs');
const { Interaction, Channel, Message, MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu, SelectMenuInteraction } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('obs')
    .setDescription('Control OBS (#obs-hub-control only')
    .addSubcommand(subcommand =>
      subcommand
        .setName('reboot')
        .setDescription('Reboot this bot.'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Create new status box'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list_scenes')
        .setDescription('List scenes'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('target_volume')
        .setDescription('Set transition target volume')
        .addNumberOption(option =>
          option.setName('db')
            .setDescription('Volume dB')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('preview_volume')
        .setDescription('Set preview source volume')
        .addNumberOption(option =>
          option.setName('db')
            .setDescription('Volume dB')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('mute_preview')
        .setDescription('Set mute status of preview source')
        .addBooleanOption(option =>
          option.setName('muted')
            .setDescription('True to mute, false to unmute')
            .setRequired(true)))
];

const STATUSBOX_UPDATE_INTERVAL_MS = 10000;
const STATUSBOX_TTL_MS = 24*60*60*1000;

const statusEmbed = new MessageEmbed()
  .setColor('#0099ff')
  .setTitle('OBS Hub Status');

const programButtonActionRow = new MessageActionRow()
  .addComponents(
    new MessageButton()
      .setCustomId('progPlayPause')
      .setEmoji('⏯️')
      .setStyle('DANGER'),
    new MessageButton()
      .setCustomId('progReload')
      .setEmoji('🔃')
      .setStyle('DANGER'),
    new MessageButton()
      .setCustomId('transition')
      .setEmoji('↔️')
      .setLabel('T')
      .setStyle('DANGER'),
    new MessageButton()
      .setCustomId('progSofter')
      .setEmoji('🔈')
      .setStyle('DANGER'),
    new MessageButton()
      .setCustomId('progLouder')
      .setEmoji('🔊')
      .setStyle('DANGER')
  )

const previewButtonActionRow = new MessageActionRow()
  .addComponents(
    new MessageButton()
      .setCustomId('prevPlayPause')
      .setEmoji('⏯️')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('prevReload')
      .setEmoji('🔃')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('prevRetransform')
      .setEmoji('🖼️')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('prevSofter')
      .setEmoji('🔈')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('prevLouder')
      .setEmoji('🔊')
      .setStyle('PRIMARY')
  )

const sceneButtonActionRow = new MessageActionRow()
  .addComponents(
    new MessageButton()
      .setCustomId('upScene')
      .setEmoji('⬆️')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('downScene')
      .setEmoji('⬇️')
      .setStyle('PRIMARY'),
    new MessageButton()
      .setCustomId('ttRetract')
      .setEmoji('⬅️')
      .setStyle('DANGER'),
      new MessageButton()
      .setCustomId('ttAdvance')
      .setEmoji('➡️')
      .setStyle('DANGER')
  )


const dbOptions = [
  { label: '0 dB', value: '0' },
  { label: '-2.5 dB', value: '-2.5' },
  { label: '-5 dB', value: '-5' },
  { label: '-7.5 dB', value: '-7.5' },
  { label: '-10 dB', value: '-10' },
  { label: '-12.5 dB', value: '-12.5' },
  { label: '-15 dB', value: '-15' },
  { label: '-17.5 dB', value: '-17.5' },
  { label: '-20 dB', value: '-20' },
  { label: '-22.5 dB', value: '-22.5' },
  { label: '-25 dB', value: '-25' },
  { label: '-27.5 dB', value: '-27.5' },
  { label: '-30 dB', value: '-30' }
]

const previewDBSelectRow = new MessageActionRow()
  .addComponents(
    new MessageSelectMenu()
      .setCustomId('selectPreviewDB')
      .setPlaceholder('Preview dB')
      .addOptions(dbOptions)
  )

const programDBSelectRow = new MessageActionRow()
  .addComponents(
    new MessageSelectMenu()
      .setCustomId('selectProgramDB')
      .setPlaceholder('Program dB')
      .addOptions([ { label: "N/A", value: "N/A"} ])
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
    this.message = await this.channel.send({embeds: [statusEmbed],
      components: [sceneButtonActionRow, previewDBSelectRow, previewButtonActionRow, programDBSelectRow, programButtonActionRow]});
    this.#updateEmbed();
    this.message.edit({embeds: [statusEmbed]})
  }

  #updateEmbed() {
    statusEmbed.setFooter({ text: `Last updated: ${this.#timestamp()}` });
    statusEmbed.setFields(
      // { name: '\u200B', value: '\u200B' },
      { name: 'RTMP Server', value: 'Not yet implemented' },
      // { name: '\u200B', value: '\u200B' },
      { name: 'OBS Hub', value: `Connected: \`${this.obs.isConnected}\`\nTransition Target Volume: \`${this.obs.transitionTargetDB} dB\`\nTransition Crossfade: \`${this.obs.transitionCrossfadeDurationSecs} sec\`\nTransition Visual Delay: \`${this.obs.transitionVisualDelaySecs} sec\`` },
      { name: 'Preview Scene', value: `${this.obs.previewSceneName}\n\`${this.obs.previewSources.map(s=>s.status).join('\n')}\``, inline: true },
      { name: 'Program Scene', value: `${this.obs.programSceneName}\n\`${this.obs.programSources.map(s=>s.status).join('\n')}\``, inline: true }
    )
  }
  
  #timestamp() {
    return new Date().toLocaleString( 'sv', { timeZoneName: 'short' } );
  }


  /**
   * @param {SelectMenuInteraction} interaction
   */
  async #select(interaction) {
    switch (interaction.customId) {
      case "selectPreviewDB":
        this.obs.setPreviewSourceVolume(parseFloat(interaction.values[0]));
        break;
      default:
        console.log("Select menu id: "+interaction.customId+" value: "+interaction.values[0])
    }
    try {
      await interaction.reply({content: null, ephemeral: true});
    } catch (err) {
      // Expect an error because content is null, so do nothing
    }
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
      case "transition":
        this.obs.transition();
        break;
      case "progLouder":
        this.obs.nudgeProgramLouder();
        break;
      case "progSofter":
        this.obs.nudgeProgramSofter();
        break;
      case "prevLouder":
        this.obs.nudgePreviewLouder();
        break;
      case "prevSofter":
        this.obs.nudgePreviewSofter();
        break;
      case "prevPlayPause":
        this.obs.playPausePreviewSource();
        break;
      case "prevReload":
        this.obs.reloadPreviewSource();
        break;
      case "prevRetransform":
        this.obs.retransformPreviewSource();
        break;
      case "progPlayPause":
        this.obs.playPauseProgramSource();
        break;
      case "progReload":
        this.obs.reloadProgramSource();
        break;
      case "ttAdvance":
        this.obs.ttAdvance();
        break;
      case "ttRetract":
        this.obs.ttRetract();
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
        case "target_volume":
          let db_target = interaction.options.getNumber('db')
          if (db_target > 0) {
            interaction.reply("Requested target greater than 0 dB. Ignoring...");
          } else {
            this.obs.transitionTargetDB = db_target;
            interaction.reply(`Transition target volume set to ${db_target} dB`)
          }
          break;
          case "preview_volume":
            let db_prev = interaction.options.getNumber('db')
            if (db_prev > 0) {
              interaction.reply("Requested target greater than 0 dB. Ignoring...");
            } else {
              this.obs.setPreviewSourceVolume(db_prev)
              interaction.reply(`Preview source volume set to ${db_prev} dB`)
            }
            break;
          case "mute_preview":
            let muted = interaction.options.getBoolean('muted')
            if (muted) {
              this.obs.mutePreviewSource();
              interaction.reply('Muted preview source')
            } else {
              this.obs.unmutePreviewSource();
              interaction.reply("Unmuted preview source")
            }
            break;
          case "reboot":
            process.exit();
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
    } else if (interaction.isSelectMenu()) {
      this.#select(interaction)
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


