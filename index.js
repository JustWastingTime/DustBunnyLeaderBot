require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  InteractionContextType,
  ApplicationIntegrationType,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://uma.moe/api/v4/circles?circle_id=883948934';
const CONFIG_PATH = path.join(__dirname, 'leaderboard-config.json');

const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  updateIntervalMinutes: parseInt(process.env.UPDATE_INTERVAL_MINUTES || '15', 10),
};

let leaderboardMessage = null; // { channelId, messageId }

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    leaderboardMessage = JSON.parse(data);
  } catch {
    leaderboardMessage = null;
  }
}

function saveConfig() {
  if (!leaderboardMessage) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(leaderboardMessage, null, 2));
}

async function fetchCircleData() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

function formatNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatIntWithCommas(n) {
  return Math.trunc(n).toLocaleString('en-US');
}

function normalizeName(raw) {
  let name = raw || 'Unknown';
  // Replace some problematic punctuation and spaces
  name = name.replace(/！/g, '!').replace(/\s+/g, ' ');
  // Map specific wide-character names to ASCII equivalents for alignment
  if (name.includes('くま')) {
    name = 'Kuma Kaibutsu';
  }
  if (name.includes('Hai')) {
    name = 'Hai!Aku Aru!';
  }
  return name;
}

function buildTrainerEmbed(circle, member, ranks) {
  const fans = member.daily_fans || [];
  const nonZeroFans = fans.filter((n) => n > 0);
  const firstFans = nonZeroFans[0] ?? 0;
  const latestFans = nonZeroFans[nonZeroFans.length - 1] ?? firstFans;
  const monthlyGain = latestFans - firstFans;
  const days = nonZeroFans.length || 1;
  const dailyAvg = Math.round(monthlyGain / days);

  const title = `${member.trainer_name} — Trainer Data`;

  const r = (n) => (n != null ? ` (#${n})` : '');
  const descriptionLines = [
    `**🔶 Total Fans:** ${formatIntWithCommas(latestFans)}${r(ranks?.totalFans)}\n`,
    `**📆 Monthly Fans:** ${formatIntWithCommas(monthlyGain)}${r(ranks?.monthly)}\n`,
    `**📊 Daily Average:** ${formatIntWithCommas(dailyAvg)}${r(ranks?.dailyAvg)}\n`,
  ];

  // Build chart: daily gain = fans that day minus previous day (start from day 2)
  const chartData = nonZeroFans
    .slice(1)
    .map((v, i) => Math.max(0, v - nonZeroFans[i]));
  const labels = chartData.map((_, idx) => `Day ${idx + 1}`);

  const qcConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Fans gained',
          data: chartData,
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          fill: true,
          tension: 0.2,
        },
      ],
    },
    options: {
      legend: { display: false },
      plugins: {
        datalabels: {
          display: true,
          align: 'top',
          anchor: 'end',
        },
        tickFormat: {
          useGrouping: true,
          locale: 'en-US',
          applyToDataLabels: true,
        },
      },
      scales: {
        xAxes: [{
          display: true,
          gridLines: { display: false },
        }],
        yAxes: [{
          display: true,
          gridLines: { display: false },
          scaleLabel: { display: true, labelString: 'Fans' },
        }],
      },
    },
  };

  const qcUrl =
    'https://quickchart.io/chart?w=600&h=300&c=' + encodeURIComponent(JSON.stringify(qcConfig));

  const embed = new EmbedBuilder()
    .setColor(15844367)
    .setTitle(title)
    .setDescription(descriptionLines.join('\n'))
    .setImage(qcUrl)
  return embed;
}

function buildLeaderboardEmbed(data) {
  const circle = data.circle;
  const members = data.members || [];

  const circleYesterdayUpdated = circle.yesterday_updated ? new Date(circle.yesterday_updated) : null;

  const activeMembers = members
    .map((m) => {
      const fans = m.daily_fans || [];
      const nonZeroFans = fans.filter((n) => n > 0);
      const firstFans = nonZeroFans[0] ?? 0;
      const latestFans = nonZeroFans[nonZeroFans.length - 1] ?? firstFans;
      const monthlyGain = latestFans - firstFans;
      const lastUpdated = m.last_updated ? new Date(m.last_updated) : null;
      const isActive =
        !circleYesterdayUpdated || (lastUpdated && lastUpdated >= circleYesterdayUpdated);
      return {
        ...m,
        currentFans: latestFans,
        monthlyGain,
        isActive,
        activeDays: nonZeroFans.length,
      };
    })
    .filter((m) => m.isActive)
    .sort((a, b) => b.monthlyGain - a.monthlyGain);

  const dailyDelta =
    typeof circle.live_points === 'number' && typeof circle.yesterday_points === 'number'
      ? circle.live_points - circle.yesterday_points
      : null;

  // Build compact table rows (without zone colors)
  const header =
    'Rank  Name             Total Fans   Daily Avg\n' +
    '---------------------------------------------';

  const rows = activeMembers.map((m, idx) => {
    const rank = `#${idx + 1}`.padEnd(4, ' ');
    let name = normalizeName(m.trainer_name || 'Unknown');
    if (name.length > 15) name = name.slice(0, 15);
    name = name.padEnd(15, ' ');
    const totalFans = formatIntWithCommas(m.monthlyGain).padStart(11, ' ');
    const days = m.activeDays || 1;
    const dailyAvg = formatIntWithCommas(Math.round(m.monthlyGain / days)).padStart(10, ' ');
    return `${rank}  ${name} ${totalFans}  ${dailyAvg}`;
  });

  // Build description with stats + one codeblock table
  const lines = [];
  lines.push(`**Current Rank:** # ${circle.live_rank}`);
  lines.push(`**Last Month's Rank:** # ${circle.last_month_rank}`);

  if (!activeMembers.length) {
    lines.push('');
    lines.push('*No active members yet*');
  } else {
    const table = ['```', header, ...rows, '```'].join('\n');
    lines.push('');
    lines.push(table);
  }

  const embed = new EmbedBuilder()
    .setColor(15844367)
    .setTitle(`🏆 ${circle.name} — Monthly Fans`)
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `Last updated • ${
        circle.last_updated ? new Date(circle.last_updated).toLocaleString() : '—'
      }`,
    })
    .setTimestamp();

  return embed;
}

function buildBananaEmbed(data) {
  const circle = data.circle;
  const members = data.members || [];

  const circleYesterdayUpdated = circle.yesterday_updated ? new Date(circle.yesterday_updated) : null;

  const activeMembers = members
    .map((m) => {
      const fans = m.daily_fans || [];
      const nonZeroFans = fans.filter((n) => n > 0);
      const firstFans = nonZeroFans[0] ?? 0;
      const latestFans = nonZeroFans[nonZeroFans.length - 1] ?? firstFans;
      const monthlyGain = latestFans - firstFans;
      const lastUpdated = m.last_updated ? new Date(m.last_updated) : null;
      const isActive =
        !circleYesterdayUpdated || (lastUpdated && lastUpdated >= circleYesterdayUpdated);
      return {
        ...m,
        monthlyGain,
        isActive,
        activeDays: nonZeroFans.length,
      };
    })
    .filter((m) => m.isActive)
    .sort((a, b) => b.monthlyGain - a.monthlyGain);

  const bananaIdx = activeMembers.findIndex(
    (m) => (m.trainer_name || '').toLowerCase() === 'banana',
  );
  const belowBanana =
    bananaIdx >= 0 ? activeMembers.slice(bananaIdx + 1) : [];

  const nameW = 15;
  const monthlyW = 14;
  const dailyW = 11;
  const header =
    'Name'.padEnd(nameW) + '  ' + 'Monthly Fans'.padStart(monthlyW) + '  ' + 'Daily Avg'.padStart(dailyW) + '\n' +
    '-'.repeat(nameW + monthlyW + dailyW + 4);

  const rows = belowBanana.map((m) => {
    let name = normalizeName(m.trainer_name || 'Unknown');
    if (name.length > nameW) name = name.slice(0, nameW);
    name = name.padEnd(nameW, ' ');
    const monthlyFans = formatIntWithCommas(m.monthlyGain).padStart(monthlyW, ' ');
    const days = m.activeDays || 1;
    const dailyAvg = formatIntWithCommas(Math.round(m.monthlyGain / days)).padStart(dailyW, ' ');
    return name + '  ' + monthlyFans + '  ' + dailyAvg;
  });

  const lines = [];

  if (!belowBanana.length) {
    lines.push('');
    lines.push(bananaIdx >= 0 ? '*No one ranked below Banana*' : '*Banana not found in circle*');
  } else {
    const table = ['```', header, ...rows, '```'].join('\n');
    lines.push('');
    lines.push(table);
  }

  const embed = new EmbedBuilder()
    .setColor(15844367)
    .setTitle(`🍌 Banana Line`)
    .setDescription(lines.join('\n'))
  return embed;
}

function escapeMarkdown(s) {
  return String(s).replace(/([*_`~|\\])/g, '\\$1');
}

async function updateLeaderboard(client) {
  if (!leaderboardMessage?.channelId || !leaderboardMessage?.messageId) return;
  try {
    const channel = await client.channels.fetch(leaderboardMessage.channelId);
    const message = await channel.messages.fetch(leaderboardMessage.messageId);
    const data = await fetchCircleData();
    const embed = buildLeaderboardEmbed(data);
    await message.edit({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to update leaderboard:', err.message);
  }
}

async function registerCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  const guildAndDm = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
  const guildOnly = [InteractionContextType.Guild];

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-leaderboard')
      .setDescription('Post the auto-updating Dust Bunny circle leaderboard in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setContexts(...guildOnly),
    new SlashCommandBuilder()
      .setName('refresh-leaderboard')
      .setDescription('Manually refresh the leaderboard now')
      .setContexts(...guildOnly),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the latest Dust Bunny circle leaderboard (no auto-update)')
      .setContexts(...guildAndDm)
      .setIntegrationTypes(ApplicationIntegrationType.UserInstall, ApplicationIntegrationType.GuildInstall),
    new SlashCommandBuilder()
      .setName('banana')
      .setDescription('Show everyone ranked below Banana (monthly fans)')
      .setContexts(...guildOnly)
      .setIntegrationTypes(ApplicationIntegrationType.UserInstall, ApplicationIntegrationType.GuildInstall),
    new SlashCommandBuilder()
      .setName('trainer')
      .setDescription("Show a trainer's fans data")
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Trainer name (leave empty to use yourself)')
          .setRequired(false),
      )
      .setContexts(...guildAndDm)
      .setIntegrationTypes(ApplicationIntegrationType.UserInstall, ApplicationIntegrationType.GuildInstall),
  ].map((c) => c.toJSON());

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

async function main() {
  if (!config.token) {
    console.error('Missing DISCORD_BOT_TOKEN. Set it in .env or your environment.');
    process.exit(1);
  }

  loadConfig();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands(client.user.id, config.token);

    const intervalMs = config.updateIntervalMinutes * 60 * 1000;
    setInterval(() => updateLeaderboard(client), intervalMs);

    if (leaderboardMessage) {
      await updateLeaderboard(client);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setup-leaderboard') {
      // Only allow admins to configure the auto-updating leaderboard
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ Only server admins can run `/setup-leaderboard`.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const data = await fetchCircleData();
        const embed = buildLeaderboardEmbed(data);
        const msg = await interaction.channel.send({ embeds: [embed] });
        leaderboardMessage = { channelId: interaction.channel.id, messageId: msg.id };
        saveConfig();
        await interaction.editReply({
          content: `✅ Leaderboard posted! It will auto-update every ${config.updateIntervalMinutes} minutes.`,
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'refresh-leaderboard') {
      await interaction.deferReply({ ephemeral: true });
      try {
        await updateLeaderboard(client);
        await interaction.editReply({ content: '✅ Leaderboard refreshed!' });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'leaderboard') {
      await interaction.deferReply();
      try {
        const data = await fetchCircleData();
        const embed = buildLeaderboardEmbed(data);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'banana') {
      await interaction.deferReply();
      try {
        const data = await fetchCircleData();
        const embed = buildBananaEmbed(data);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'trainer') {
      await interaction.deferReply();
      try {
        const data = await fetchCircleData();
        const circle = data.circle;
        const members = data.members || [];

        const nameArg = interaction.options.getString('name');
        let targetName = nameArg;

        // TODO: If no name is provided, map Discord user -> trainer later.
        if (!targetName) {
          await interaction.editReply({
            content:
              'Please provide a trainer name for now, e.g. `/trainer Izuuuu` (automatic mapping will be added later).',
          });
          return;
        }

        const lowerTarget = targetName.toLowerCase();
        const member =
          members.find((m) => (m.trainer_name || '').toLowerCase() === lowerTarget) ||
          members.find((m) => (m.trainer_name || '').toLowerCase().includes(lowerTarget));

        if (!member) {
          await interaction.editReply({
            content: `❌ Could not find trainer \`${targetName}\` in ${circle.name}.`,
          });
          return;
        }

        const circleYesterdayUpdated = circle.yesterday_updated ? new Date(circle.yesterday_updated) : null;
        const enriched = (data.members || [])
          .map((m) => {
            const f = m.daily_fans || [];
            const nz = f.filter((n) => n > 0);
            const first = nz[0] ?? 0;
            const latest = nz[nz.length - 1] ?? first;
            const gain = latest - first;
            const d = nz.length || 1;
            const lastUp = m.last_updated ? new Date(m.last_updated) : null;
            const active = !circleYesterdayUpdated || (lastUp && lastUp >= circleYesterdayUpdated);
            return { ...m, totalFans: latest, monthlyGain: gain, dailyAvg: Math.round(gain / d), isActive: active };
          })
          .filter((m) => m.isActive);

        const byTotalFans = [...enriched].sort((a, b) => b.totalFans - a.totalFans);
        const byMonthly = [...enriched].sort((a, b) => b.monthlyGain - a.monthlyGain);
        const byDailyAvg = [...enriched].sort((a, b) => b.dailyAvg - a.dailyAvg);

        const idx = (arr) => {
          const i = arr.findIndex((m) => m.viewer_id === member.viewer_id);
          return i >= 0 ? i + 1 : null;
        };

        const ranks = { totalFans: idx(byTotalFans), monthly: idx(byMonthly), dailyAvg: idx(byDailyAvg) };

        const embed = buildTrainerEmbed(circle, member, ranks);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    }
  });

  client.login(config.token);
}

main().catch(console.error);
