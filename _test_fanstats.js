const fs = require('fs');
const src = fs.readFileSync('D:/Documents/Uma/DustBunnyLeaderBot/index.js', 'utf8');
const start = src.indexOf('const EMPTY_FAN_STATS');
const end = src.indexOf('function getMemberLastUpdatedMs');
eval(src.slice(start, end) + '\nglobalThis.__g = getMemberFanStats;');
const fn = globalThis.__g;

const cases = [
  {
    n: 'SHINSUI (joined at reset)',
    d: [0, 306439243, 309435351, 313518215, 316582525, 320720624, 323408476, 329820533, 334001772, 338919143, 344179597, 349409879, 354547947, 357309405, 361436741, 365535277, 366564700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    expectContribution: 366564700 - 306439243,
    expectAvgDays: 15,
  },
  {
    n: 'Prismal (mid-month transfer)',
    d: [0, -499031661, -500046687, -500046687, -503032276, -504921966, 509725952, 512637662, 512637662, 513595445, 513595445, 514538839, 514538839, 516402834, 516402834, 517454620, 517454620, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    expectContribution: 517454620 - 504921966,
    expectAvgDays: 11,
  },
  {
    n: 'Sensaw (mid-month transfer)',
    d: [-29615562, 0, -35553610, -38131865, -40642597, -43050518, -43923729, -44740442, -44746157, -45582288, -48844389, -53941451, -57958654, -60803453, 0, 66499861, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    expectContribution: 66499861 - 60803453,
    expectAvgDays: 2,
  },
  {
    n: 'NormalBaseline',
    d: [-1000000, 1050000, 1100000, 1200000, 0, 0, 0],
    expectContribution: 1200000 - 1000000,
    expectAvgDays: 3,
  },
  {
    n: 'NoLeadingZero',
    d: [100, 200, 300, 0, 0],
    expectContribution: 300 - 100,
    expectAvgDays: 2,
  },
  {
    n: 'NormalWithGap',
    d: [-1000000, 1050000, 0, 1200000, 0, 0, 0],
    expectContribution: 1200000 - 1000000,
    expectAvgDays: 3,
  },
];

let allOk = true;
for (const c of cases) {
  const s = fn(c.d);
  const dailyAvg = Math.round(s.monthlyGain / s.averageDays);
  const ok = s.contributionFans === c.expectContribution && s.averageDays === c.expectAvgDays;
  if (!ok) allOk = false;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${c.n}`);
  console.log(`     contribution: ${s.contributionFans} (expected ${c.expectContribution})`);
  console.log(`     averageDays:  ${s.averageDays} (expected ${c.expectAvgDays})`);
  console.log(`     dailyAvg:     ${dailyAvg.toLocaleString('en-US')}`);
}
console.log(allOk ? '\nALL TESTS PASS' : '\nSOME TESTS FAILED');
