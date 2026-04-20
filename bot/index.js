const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const axios = require("axios");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// In-memory config: { guildId: { channelId, webhookUrl } }
const guildConfig = {};

// ─────────────────────────────────────────────
//  Slash Commands Registration
// ─────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the channel where Roblox cross-chat logs will appear")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The channel to log messages in")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("crosschat")
    .setDescription("Show cross-chat status for this server"),
].map((cmd) => cmd.toJSON());

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("✅ Slash commands registered globally");
  } catch (err) {
    console.error("❌ Failed to register slash commands:", err);
  }
});

// ─────────────────────────────────────────────
//  Slash Command Handlers
// ─────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setchannel") {
    const channel = interaction.options.getChannel("channel");
    guildConfig[interaction.guildId] = {
      channelId: channel.id,
      channelName: channel.name,
    };
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("✅ Cross-Chat Channel Set")
          .setDescription(
            `Roblox messages will now appear in <#${channel.id}>`
          )
          .setFooter({ text: "Roblox ↔ Discord Cross-Chat" })
          .setTimestamp(),
      ],
    });
  }

  if (interaction.commandName === "crosschat") {
    const cfg = guildConfig[interaction.guildId];
    if (!cfg) {
      return interaction.reply({
        content:
          "❌ No channel set yet. Use `/setchannel` to configure cross-chat.",
        ephemeral: true,
      });
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00e5ff)
          .setTitle("📡 Cross-Chat Status")
          .addFields(
            { name: "Status", value: "🟢 Active", inline: true },
            {
              name: "Log Channel",
              value: `<#${cfg.channelId}>`,
              inline: true,
            }
          )
          .setFooter({ text: "Roblox ↔ Discord Cross-Chat" })
          .setTimestamp(),
      ],
    });
  }
});

// ─────────────────────────────────────────────
//  Discord → Roblox relay (listen for messages)
//  If a Discord user sends in the configured channel,
//  store it so Roblox can poll it.
// ─────────────────────────────────────────────
const pendingDiscordMessages = []; // ring buffer, max 50

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  // Check if this message is in any configured channel
  for (const [guildId, cfg] of Object.entries(guildConfig)) {
    if (message.channelId === cfg.channelId) {
      pendingDiscordMessages.push({
        author: message.author.username,
        content: message.content,
        avatarUrl: message.author.displayAvatarURL({ size: 64 }),
        timestamp: new Date().toISOString(),
        source: "discord",
      });
      if (pendingDiscordMessages.length > 50)
        pendingDiscordMessages.shift();
    }
  }
});

// ─────────────────────────────────────────────
//  REST API — called by Roblox scripts
// ─────────────────────────────────────────────

// POST /chat  — Roblox sends a chat message here
app.post("/chat", async (req, res) => {
  const {
    server_key,       // matches process.env.SERVER_KEY for auth
    guild_id,         // which Discord guild to log to
    username,
    user_id,
    message,
    place_id,
    place_name,
    avatar_url,
  } = req.body;

  // Simple auth
  if (server_key !== process.env.SERVER_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (!guild_id || !guildConfig[guild_id]) {
    return res
      .status(400)
      .json({ success: false, error: "Guild not configured or not found" });
  }

  const cfg = guildConfig[guild_id];
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) {
    return res
      .status(404)
      .json({ success: false, error: "Channel not found" });
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  const dateStr = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setAuthor({
      name: `${username} • Roblox`,
      iconURL:
        avatar_url ||
        `https://www.roblox.com/headshot-thumbnail/image?userId=${user_id}&width=48&height=48&format=png`,
      url: `https://www.roblox.com/users/${user_id}/profile`,
    })
    .setDescription(`💬 ${message}`)
    .addFields(
      { name: "🎮 Place", value: place_name || "Unknown", inline: true },
      { name: "🆔 User ID", value: String(user_id), inline: true },
      { name: "📍 Place ID", value: String(place_id || "N/A"), inline: true }
    )
    .setFooter({ text: `🕐 ${timeStr} UTC  •  📅 ${dateStr}` })
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
    return res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    return res.status(500).json({ success: false, error: "Failed to send" });
  }
});

// GET /poll?guild_id=xxx&server_key=xxx  — Roblox polls for Discord messages
app.get("/poll", (req, res) => {
  const { guild_id, server_key } = req.query;

  if (server_key !== process.env.SERVER_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Return and clear pending messages
  const msgs = pendingDiscordMessages.splice(0, pendingDiscordMessages.length);
  return res.json({ success: true, messages: msgs });
});

// GET /  — health check for Render
app.get("/", (req, res) => {
  res.send("🟢 Roblox Cross-Chat Bot is running!");
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
