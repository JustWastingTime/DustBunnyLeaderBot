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
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const PRIMARY_CIRCLE_ID = '883948934';
const SECONDARY_CIRCLE_ID = '419653159';
const PRIMARY_TARGET_API = 'https://uma.moe/api/v4/circles/list?page=99&limit=1';
const SECONDARY_TARGET_API = 'https://uma.moe/api/v4/circles/list?page=499&limit=1';
const CIRCLE_APIS = {
  [PRIMARY_CIRCLE_ID]: `https://uma.moe/api/v4/circles?circle_id=${PRIMARY_CIRCLE_ID}`,
  [SECONDARY_CIRCLE_ID]: `https://uma.moe/api/v4/circles?circle_id=${SECONDARY_CIRCLE_ID}`,
};
const CONFIG_PATH = path.join(__dirname, 'leaderboard-config.json');
const LINKS_PATH = path.join(__dirname, 'user-links.json');

const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  umaApiKey: process.env.UMA_API_KEY,
  updateIntervalMinutes: parseInt(process.env.UPDATE_INTERVAL_MINUTES || '15', 10),
};

let leaderboardMessage = null; // { channelId, messageId }
let userLinks = {}; // { [discordUserId]: { umaId, circleId } }

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

function loadLinks() {
  try {
    const data = fs.readFileSync(LINKS_PATH, 'utf8');
    const parsed = JSON.parse(data);
    // Backward compatibility: older format stored only trainer name string.
    userLinks = Object.fromEntries(
      Object.entries(parsed).map(([discordUserId, value]) => {
        if (typeof value === 'string') {
          return [
            discordUserId,
            {
              umaId: value,
              circleId: PRIMARY_CIRCLE_ID,
            },
          ];
        }
        return [
          discordUserId,
          {
            umaId: value?.umaId || '',
            circleId:
              value?.circleId === SECONDARY_CIRCLE_ID
                ? SECONDARY_CIRCLE_ID
                : PRIMARY_CIRCLE_ID,
          },
        ];
      }),
    );
  } catch {
    userLinks = {};
  }
}

function saveLinks() {
  try {
    fs.writeFileSync(LINKS_PATH, JSON.stringify(userLinks, null, 2));
  } catch (err) {
    console.error('Failed to save user links:', err.message);
  }
}

function getCircleApiUrl(circleId) {
  return CIRCLE_APIS[circleId] || CIRCLE_APIS[PRIMARY_CIRCLE_ID];
}

function getLinkedCircleId(discordUserId) {
  const linked = userLinks[discordUserId];
  if (!linked) return PRIMARY_CIRCLE_ID;
  return linked.circleId === SECONDARY_CIRCLE_ID ? SECONDARY_CIRCLE_ID : PRIMARY_CIRCLE_ID;
}

function getUmaHeaders() {
  const headers = {};
  if (config.umaApiKey) {
    headers['X-API-Key'] = config.umaApiKey;
  }
  return headers;
}

async function fetchUmaJson(url) {
  const res = await fetch(url, { headers: getUmaHeaders() });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

async function fetchCircleData(circleId = PRIMARY_CIRCLE_ID) {
  return fetchUmaJson(getCircleApiUrl(circleId));
}

// The monthly tracking period boundary is day 2 at 00:00 JST.
// Day 1 of any JST calendar month still belongs to the *previous*
// month's period (e.g. June 1 JST counts as May data).
function getEffectiveJstPeriod(now = new Date()) {
  const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  let year = jstNow.getFullYear();
  let month = jstNow.getMonth();
  if (jstNow.getDate() < 2) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return { year, month, jstNow };
}

function getDaysSinceJstMonthSecondMidnight(now = new Date()) {
  const { year, month, jstNow } = getEffectiveJstPeriod(now);
  const jstSecondMidnight = new Date(year, month, 2, 0, 0, 0, 0);
  const elapsedMs = Math.max(0, jstNow.getTime() - jstSecondMidnight.getTime());
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  return Math.max(elapsedHours / 24, 1 / 24);
}

async function fetchCurrentTarget(circleId) {
  const targetApi = circleId === SECONDARY_CIRCLE_ID ? SECONDARY_TARGET_API : PRIMARY_TARGET_API;
  const payload = await fetchUmaJson(targetApi);
  const firstCircle = Array.isArray(payload?.circles) ? payload.circles[0] : null;
  if (!firstCircle) return null;

  const totalPoints =
    circleId === SECONDARY_CIRCLE_ID ? firstCircle.monthly_point : firstCircle.live_points;
  if (typeof totalPoints !== 'number') return null;

  const daysElapsed = getDaysSinceJstMonthSecondMidnight();
  return totalPoints / 30 / daysElapsed;
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

function formatCompactInt(n) {
  return formatNumber(Math.trunc(n));
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

function stripDisplaySuffix(name) {
  // Some trainer names include club tags like "Name@BUNS" (or fullwidth ＠).
  // Strip suffixes for leaderboard table display to keep rows within embed width.
  const stripped = String(name || '').replace(/\s*[@＠].*$/u, '').trimEnd();
  return stripped || String(name || '');
}

function truncateAndPadName(rawName, width) {
  let name = normalizeName(rawName || 'Unknown');
  name = stripDisplaySuffix(name);
  if (name.length > width) name = name.slice(0, width);
  return name.padEnd(width, ' ');
}

const EMPTY_FAN_STATS = {
  dailyFans: [],
  monthlyGain: 0,
  contributionFans: 0,
  firstFans: 0,
  latestFans: 0,
  averageDays: 1,
  activeDays: 0,
};

// Parse a member's `daily_fans` array into normalized stats.
//
// Semantics encoded here:
//  - Trailing zeros after the last positive entry are future calendar days
//    we have no data for and are dropped.
//  - A *single* negative at index 0 is the well-known API quirk where the
//    first slot stores the previous-month baseline for THIS circle. Its
//    magnitude is the baseline total fans.
//  - Any other negative entries represent fan totals recorded by the
//    member's previous circle (they transferred in mid-month). The most
//    recent such negative is their fan total at the moment they left their
//    old circle, so its magnitude is the correct contribution baseline.
//    Everything before it is dropped.
//  - A *leading* zero with no negatives anywhere means the trainer joined
//    THIS circle at the monthly reset from a different circle, so uma.moe
//    never recorded a previous-month baseline. The first positive entry
//    after the leading zero(s) is the real baseline.
//  - Zeros inside the active window mean "scrape missed this day" (common
//    during a club transition; Dust Bunny is updated more frequently than
//    Dirt Bunny, which often lags a day in JST). They are forward-filled
//    with the previous known total so daily-gain math doesn't double-count
//    or spike.
//
// Resulting `dailyFans` always begins with a baseline entry, so callers
// can treat `length - 1` as the number of in-circle day intervals.
function getMemberFanStats(rawFans) {
  const fans = Array.isArray(rawFans) ? rawFans.filter((n) => typeof n === 'number') : [];
  const lastPositiveIdx = fans.reduce((idx, n, i) => (n > 0 ? i : idx), -1);
  if (lastPositiveIdx < 0) return { ...EMPTY_FAN_STATS };

  const trimmed = fans.slice(0, lastPositiveIdx + 1);

  let lastNegativeIdx = -1;
  let negativeCount = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] < 0) {
      lastNegativeIdx = i;
      negativeCount += 1;
    }
  }

  const isPreviousMonthBaselineOnly = negativeCount === 1 && lastNegativeIdx === 0;

  let dailyFans;

  if (lastNegativeIdx < 0) {
    const firstPositiveIdx = trimmed.findIndex((n) => n > 0);
    const start = firstPositiveIdx > 0 ? firstPositiveIdx : 0;
    let prev = trimmed[start];
    dailyFans = trimmed.slice(start).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
  } else if (isPreviousMonthBaselineOnly) {
    const baseline = Math.abs(trimmed[0]);
    let prev = baseline;
    const rest = trimmed.slice(1).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
    dailyFans = [baseline, ...rest];
  } else {
    const baseline = Math.abs(trimmed[lastNegativeIdx]);
    let prev = baseline;
    const postJoin = trimmed.slice(lastNegativeIdx + 1).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
    dailyFans = [baseline, ...postJoin];
  }

  if (!dailyFans.length) return { ...EMPTY_FAN_STATS };

  const firstFans = dailyFans[0] ?? 0;
  const latestFans = dailyFans[dailyFans.length - 1] ?? firstFans;
  const monthlyGain = latestFans - firstFans;
  const averageDays = Math.max(1, dailyFans.length - 1);

  return {
    dailyFans,
    monthlyGain,
    contributionFans: monthlyGain,
    firstFans,
    latestFans,
    averageDays,
    activeDays: dailyFans.length,
  };
}

function getMemberLastUpdatedMs(member) {
  if (!member?.last_updated) return null;
  const t = new Date(member.last_updated).getTime();
  return Number.isFinite(t) ? t : null;
}

// Members still in the club are all refreshed together, so anyone whose
// `last_updated` lags meaningfully behind the freshest member has effectively
// left the circle. We use a 2h tolerance to absorb normal scrape jitter.
const ACTIVE_LAG_TOLERANCE_MS = 2 * 60 * 60 * 1000;

function getActiveCutoffMs(members) {
  const stamps = (members || [])
    .map(getMemberLastUpdatedMs)
    .filter((t) => t != null);
  if (!stamps.length) return null;
  return Math.max(...stamps) - ACTIVE_LAG_TOLERANCE_MS;
}

function isMemberActive(member, cutoffMs) {
  const ts = getMemberLastUpdatedMs(member);
  if (ts == null) return false;
  if (cutoffMs == null) return true;
  return ts >= cutoffMs;
}

function buildTrainerEmbed(circle, member, ranks) {
  const fanStats = getMemberFanStats(member.daily_fans);
  const dailyAvg = Math.round(fanStats.monthlyGain / fanStats.averageDays);

  const title = `${member.trainer_name} — Trainer Data`;

  const r = (n) => (n != null ? ` (#${n})` : '');
  const descriptionLines = [
    `**🔶 Total Fans:** ${formatIntWithCommas(fanStats.latestFans)}${r(ranks?.totalFans)}\n`,
    `**📆 Monthly Fans:** ${formatIntWithCommas(fanStats.monthlyGain)}${r(ranks?.monthly)}\n`,
    `**📊 Daily Average:** ${formatIntWithCommas(dailyAvg)}${r(ranks?.dailyAvg)}\n`,
  ];

  // Build chart: daily gain = fans that day minus previous day (start from day 2)
  const chartData = fanStats.dailyFans
    .slice(1)
    .map((v, i) => Math.max(0, v - fanStats.dailyFans[i]));
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

function buildTrainerRanks(circle, members, targetViewerId) {
  const cutoff = getActiveCutoffMs(members);
  const enriched = (members || [])
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        totalFans: fanStats.latestFans,
        monthlyGain: fanStats.monthlyGain,
        dailyAvg: Math.round(fanStats.monthlyGain / fanStats.averageDays),
      };
    });

  const byTotalFans = [...enriched].sort((a, b) => b.totalFans - a.totalFans);
  const byMonthly = [...enriched].sort((a, b) => b.monthlyGain - a.monthlyGain);
  const byDailyAvg = [...enriched].sort((a, b) => b.dailyAvg - a.dailyAvg);

  const idx = (arr) => {
    const i = arr.findIndex((m) => m.viewer_id === targetViewerId);
    return i >= 0 ? i + 1 : null;
  };

  return { totalFans: idx(byTotalFans), monthly: idx(byMonthly), dailyAvg: idx(byDailyAvg) };
}

function findTrainerCandidates(targetName, datasets) {
  const lowerTarget = targetName.toLowerCase();

  const exact = [];
  const partial = [];
  for (const dataset of datasets) {
    for (const member of dataset.members) {
      const lowerName = (member.trainer_name || '').toLowerCase();
      if (lowerName === lowerTarget) {
        exact.push({ ...dataset, member });
      } else if (lowerName.includes(lowerTarget)) {
        partial.push({ ...dataset, member });
      }
    }
  }

  return exact.length ? exact : partial;
}

function buildLeaderboardEmbed(data, currentTarget = null) {
  const circle = data.circle;
  const members = data.members || [];

  const cutoff = getActiveCutoffMs(members);

  const activeMembers = members
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        currentFans: fanStats.latestFans,
        monthlyGain: fanStats.monthlyGain,
        contributionFans: fanStats.contributionFans,
        averageDays: fanStats.averageDays,
      };
    })
    .sort((a, b) => b.contributionFans - a.contributionFans);

  const dailyDelta =
    typeof circle.live_points === 'number' && typeof circle.yesterday_points === 'number'
      ? circle.live_points - circle.yesterday_points
      : null;

  // Build compact table rows (without zone colors)
  const nameW = 13;
  const rankW = 4;
  const totalW = 6;
  const dailyW = 6;
  const header =
    'Rank Name           Total  Daily  \n' +
    '----------------------------------  ';

  const rows = activeMembers.map((m, idx) => {
    const rank = `#${idx + 1}`.padEnd(rankW, ' ');
    const name = truncateAndPadName(m.trainer_name, nameW);
    const totalFans = formatCompactInt(m.contributionFans).padStart(totalW, ' ');
    const dailyAvg = formatCompactInt(Math.round(m.monthlyGain / m.averageDays)).padStart(dailyW, ' ');
    return `${rank} ${name} ${totalFans} ${dailyAvg}  `;
  });

  // Build description with stats + one codeblock table
  const lines = [];
  const currentRank = circle.live_rank ?? circle.monthly_rank ?? '—';
  lines.push(`**Current Rank:** # ${currentRank}`);
  lines.push(`**Last Month's Rank:** # ${circle.last_month_rank}`);
  lines.push(
    `**Current Target:** ${currentTarget == null ? '—' : formatIntWithCommas(Math.round(currentTarget))}`,
  );

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

function getActiveMembersWithMonthlyGain(data, clubName) {
  const members = data.members || [];
  const cutoff = getActiveCutoffMs(members);

  return members
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        clubName,
        monthlyGain: fanStats.monthlyGain,
        contributionFans: fanStats.contributionFans,
        averageDays: fanStats.averageDays,
      };
    });
}

function buildAllLeaderboardEmbeds(dustData, dirtData) {
  const combined = [
    ...getActiveMembersWithMonthlyGain(dustData, 'Dust'),
    ...getActiveMembersWithMonthlyGain(dirtData, 'Dirt'),
  ].sort((a, b) => b.contributionFans - a.contributionFans);

  const perPage = 30;
  const totalPages = Math.max(1, Math.ceil(combined.length / perPage));
  const embeds = [];

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
    const start = pageIdx * perPage;
    const pageMembers = combined.slice(start, start + perPage);

    const nameW = 10;
    const rankW = 4;
    const clubW = 4;
    const monthlyW = 7;
    const dailyW = 6;
    const header =
      'Rank Name        Club Monthly  Daily  \n' +
      '--------------------------------------  ';
    const rows = pageMembers.map((m, idx) => {
      const rank = `#${start + idx + 1}`.padEnd(rankW, ' ');
      const name = truncateAndPadName(m.trainer_name, nameW);
      const club = (m.clubName || '—').slice(0, clubW).padEnd(clubW, ' ');
      const monthlyFans = formatCompactInt(m.contributionFans).padStart(monthlyW, ' ');
      const dailyAvg = formatCompactInt(Math.round(m.monthlyGain / m.averageDays)).padStart(dailyW, ' ');
      return `${rank} ${name} ${club} ${monthlyFans} ${dailyAvg}  `;
    });

    const lines = [];
    lines.push('**Combined Clubs:** Dust Bunny + Dirt Bunny');
    lines.push(`**Total Active Members:** ${combined.length}`);
    lines.push(`**Page:** ${pageIdx + 1}/${totalPages}`);
    lines.push('');
    lines.push(['```', header, ...rows, '```'].join('\n'));

    embeds.push(
      new EmbedBuilder()
        .setColor(15844367)
        .setTitle('🏆 All Clubs — Monthly Fans')
        .setDescription(lines.join('\n'))
        .setTimestamp(),
    );
  }

  return embeds;
}

function buildLeaderboardPageButtons(pageIdx, totalPages, interactionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leaderboard-prev:${interactionId}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIdx <= 0),
    new ButtonBuilder()
      .setCustomId(`leaderboard-next:${interactionId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIdx >= totalPages - 1),
  );
}

async function sendPaginatedEmbeds(interaction, embeds) {
  let pageIdx = 0;
  const totalPages = embeds.length;

  await interaction.editReply({
    embeds: [embeds[pageIdx]],
    components: totalPages > 1 ? [buildLeaderboardPageButtons(pageIdx, totalPages, interaction.id)] : [],
  });

  if (totalPages <= 1) return;

  const reply = await interaction.fetchReply();
  while (true) {
    try {
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 120000,
        filter: (i) =>
          i.user.id === interaction.user.id &&
          (i.customId === `leaderboard-prev:${interaction.id}` ||
            i.customId === `leaderboard-next:${interaction.id}`),
      });

      if (button.customId === `leaderboard-prev:${interaction.id}`) {
        pageIdx = Math.max(0, pageIdx - 1);
      } else if (button.customId === `leaderboard-next:${interaction.id}`) {
        pageIdx = Math.min(totalPages - 1, pageIdx + 1);
      }

      await button.update({
        embeds: [embeds[pageIdx]],
        components: [buildLeaderboardPageButtons(pageIdx, totalPages, interaction.id)],
      });
    } catch {
      await interaction.editReply({
        embeds: [embeds[pageIdx]],
        components: [],
      });
      return;
    }
  }
}

function buildBananaEmbed(data) {
  const members = data.members || [];

  const cutoff = getActiveCutoffMs(members);

  const activeMembers = members
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        monthlyGain: fanStats.monthlyGain,
        contributionFans: fanStats.contributionFans,
        averageDays: fanStats.averageDays,
      };
    })
    .sort((a, b) => b.contributionFans - a.contributionFans);

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
    let name = stripDisplaySuffix(normalizeName(m.trainer_name || 'Unknown'));
    if (name.length > nameW) name = name.slice(0, nameW);
    name = name.padEnd(nameW, ' ');
    const monthlyFans = formatIntWithCommas(m.contributionFans).padStart(monthlyW, ' ');
    const dailyAvg = formatIntWithCommas(Math.round(m.monthlyGain / m.averageDays)).padStart(dailyW, ' ');
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
    const [data, currentTarget] = await Promise.all([
      fetchCircleData(PRIMARY_CIRCLE_ID),
      fetchCurrentTarget(PRIMARY_CIRCLE_ID),
    ]);
    const embed = buildLeaderboardEmbed(data, currentTarget);
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
      .addStringOption((option) =>
        option
          .setName('club')
          .setDescription('Optional: view a specific club leaderboard')
          .setRequired(false)
          .addChoices(
            { name: 'Dust Bunny', value: PRIMARY_CIRCLE_ID },
            { name: 'Dirt Bunny', value: SECONDARY_CIRCLE_ID },
            { name: 'All Clubs (Dust + Dirt)', value: 'all' },
          ),
      )
      .setContexts(...guildAndDm)
      .setIntegrationTypes(ApplicationIntegrationType.UserInstall, ApplicationIntegrationType.GuildInstall),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Uma Trainer to your Discord account')
      .addStringOption((option) =>
        option
          .setName('uma_id')
          .setDescription('Your Uma trainer name')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('club')
          .setDescription('Which club you are in')
          .setRequired(true)
          .addChoices(
            { name: 'Dust Bunny', value: PRIMARY_CIRCLE_ID },
            { name: 'Dirt Bunny', value: SECONDARY_CIRCLE_ID },
          ),
      )
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
  loadLinks();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', async () => {
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
        const [data, currentTarget] = await Promise.all([
          fetchCircleData(PRIMARY_CIRCLE_ID),
          fetchCurrentTarget(PRIMARY_CIRCLE_ID),
        ]);
        const embed = buildLeaderboardEmbed(data, currentTarget);
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
        const selectedClub = interaction.options.getString('club');
        if (selectedClub === 'all') {
          const [dustData, dirtData] = await Promise.all([
            fetchCircleData(PRIMARY_CIRCLE_ID),
            fetchCircleData(SECONDARY_CIRCLE_ID),
          ]);
          const embeds = buildAllLeaderboardEmbeds(dustData, dirtData);
          await sendPaginatedEmbeds(interaction, embeds);
          return;
        }

        const circleId =
          selectedClub === PRIMARY_CIRCLE_ID || selectedClub === SECONDARY_CIRCLE_ID
            ? selectedClub
            : getLinkedCircleId(interaction.user.id);
        const [data, currentTarget] = await Promise.all([
          fetchCircleData(circleId),
          fetchCurrentTarget(circleId),
        ]);
        const embed = buildLeaderboardEmbed(data, currentTarget);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'link') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const umaId = interaction.options.getString('uma_id', true);
        const circleId = interaction.options.getString('club', true);
        userLinks[interaction.user.id] = { umaId, circleId };
        saveLinks();
        const clubName = circleId === SECONDARY_CIRCLE_ID ? 'Dirt Bunny' : 'Dust Bunny';
        await interaction.editReply({
          content: `✅ Linked your Discord account by Uma Trainer name \`${escapeMarkdown(umaId)}\` in **${clubName}**. You can now use \`/trainer\` and \`/leaderboard\` for your club.`,
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed to link: ${err.message}` });
      }
    } else if (interaction.commandName === 'banana') {
      await interaction.deferReply();
      try {
        const data = await fetchCircleData(PRIMARY_CIRCLE_ID);
        const embed = buildBananaEmbed(data);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    } else if (interaction.commandName === 'trainer') {
      await interaction.deferReply();
      try {
        const nameArg = interaction.options.getString('name');
        let targetName = nameArg;

        if (!targetName) {
          const linked = userLinks[interaction.user.id];
          if (!linked?.umaId) {
            await interaction.editReply({
              content:
                'You have not linked your Uma ID yet. Use `/link` to connect your Uma ID and club, or provide a trainer name, e.g. `/trainer Izuuuu`.',
            });
            return;
          }
          targetName = linked.umaId;
        }

        const [dustData, dirtData] = await Promise.all([
          fetchCircleData(PRIMARY_CIRCLE_ID),
          fetchCircleData(SECONDARY_CIRCLE_ID),
        ]);

        const datasets = [
          {
            circleId: PRIMARY_CIRCLE_ID,
            clubName: 'Dust Bunny',
            circle: dustData.circle,
            members: dustData.members || [],
          },
          {
            circleId: SECONDARY_CIRCLE_ID,
            clubName: 'Dirt Bunny',
            circle: dirtData.circle,
            members: dirtData.members || [],
          },
        ];

        const candidates = findTrainerCandidates(targetName, datasets);
        if (!candidates.length) {
          await interaction.editReply({
            content: `❌ Could not find trainer \`${targetName}\` in Dust Bunny or Dirt Bunny.`,
          });
          return;
        }

        if (candidates.length === 1) {
          const selected = candidates[0];
          const ranks = buildTrainerRanks(
            selected.circle,
            selected.members,
            selected.member.viewer_id,
          );
          const embed = buildTrainerEmbed(selected.circle, selected.member, ranks);
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        const limited = candidates.slice(0, 25);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`trainer-pick:${interaction.id}`)
          .setPlaceholder('Multiple trainers found, choose one')
          .addOptions(
            limited.map((c, idx) => ({
              label: (c.member.trainer_name || 'Unknown').slice(0, 100),
              value: String(idx),
              description: `${c.clubName} • viewer ${c.member.viewer_id}`.slice(0, 100),
            })),
          );
        const row = new ActionRowBuilder().addComponents(select);

        await interaction.editReply({
          content: `Found multiple matches for \`${targetName}\`. Choose one:`,
          components: [row],
          embeds: [],
        });

        const reply = await interaction.fetchReply();
        const picked = await reply.awaitMessageComponent({
          componentType: ComponentType.StringSelect,
          time: 60000,
          filter: (i) =>
            i.user.id === interaction.user.id && i.customId === `trainer-pick:${interaction.id}`,
        });

        const pickedIdx = parseInt(picked.values[0], 10);
        const selected = limited[pickedIdx];
        if (!selected) {
          await picked.update({ content: '❌ Invalid selection.', components: [] });
          return;
        }

        const ranks = buildTrainerRanks(
          selected.circle,
          selected.members,
          selected.member.viewer_id,
        );
        const embed = buildTrainerEmbed(selected.circle, selected.member, ranks);
        await picked.update({ content: '', components: [], embeds: [embed] });
      } catch (err) {
        if (/time/i.test(err?.message || '')) {
          await interaction.editReply({
            content: '⏱️ Selection timed out. Run `/trainer` again.',
            components: [],
            embeds: [],
          });
          return;
        }
        await interaction.editReply({ content: `❌ Failed: ${err.message}`, components: [] });
      }
    }
  });

  client.login(config.token);
}

main().catch(console.error);
