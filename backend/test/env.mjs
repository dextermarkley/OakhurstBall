// Which stack the live tests run against. Alpha by default: test there first.
//   OAKHURST_ENV=alpha (default) | prod
const STAGES = {
  alpha: {
    BASE: 'https://alpha.oakhurst-ball.org',
    TABLE: 'oakhurst-alpha',
    POOL: 'us-west-2_5u6ysfKDp',
    CLIENT: '3sam8fji3f5oupm62iv4ldta8h',
    BUCKET: 'oakhurstbasketballalpha-chatmedia5bcb02ee-khjd85wivctp',
    PARAM_PREFIX: '/oakhurst-alpha',
    FN_PREFIX: 'oakhurst-alpha',
  },
  prod: {
    BASE: 'https://oakhurst-ball.org',
    TABLE: 'oakhurst',
    POOL: 'us-west-2_sgaAJES20',
    CLIENT: '2fm9q7bir02ib5upgeeelivdii',
    BUCKET: 'oakhurstbasketball-chatmedia5bcb02ee-j1khrlkzs6w1',
    PARAM_PREFIX: '/oakhurst',
    FN_PREFIX: 'oakhurst',
  },
};
export const STAGE = process.env.OAKHURST_ENV ?? 'alpha';
if (!STAGES[STAGE]) throw new Error(`OAKHURST_ENV must be alpha or prod, not ${STAGE}`);
export const { BASE, TABLE, POOL, CLIENT, BUCKET, PARAM_PREFIX, FN_PREFIX } = STAGES[STAGE];
console.log(`[live test on ${STAGE}: ${BASE}]`);
