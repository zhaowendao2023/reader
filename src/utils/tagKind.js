// 标签类型（kind）：标签之间天然不同——作者 / 系列 / 角色 / 题材。
// kind 入库（tags.kind，Rust 端归一为 author|series|character|genre|""）；
// 未设置时前端按启发式自动推测（仅展示建议，不落库），编辑弹窗/右键菜单可手改。
export const TAG_KIND_ORDER = ["author", "series", "character", "genre", ""];

export const TAG_KINDS = [
  { value: "author", label: "作者", icon: "pencil" },
  { value: "series", label: "系列", icon: "layers" },
  { value: "character", label: "角色", icon: "star" },
  { value: "genre", label: "题材", icon: "sparkles" },
  { value: "", label: "其它", icon: "tag" },
];

export const kindLabel = (kind) =>
  (TAG_KINDS.find((k) => k.value === kind) || TAG_KINDS[TAG_KINDS.length - 1]).label;

// 题材词库（精确匹配标签名）。注意不要收纳「偶像大师」这类系列名——
// 系列靠条目数/标题推断，这里只放真正的概念/题材词。
const GENRE_WORDS = [
  "萝莉", "正太", "御姐", "姐系", "妹系", "傲娇", "病娇", "金发", "黑长直",
  "巨乳", "贫乳", "眼镜", "丝袜", "猫耳", "兽耳", "女仆", "护士", "教师",
  "巫女", "修女", "偶像", "纯爱", "恋爱", "后宫", "逆后宫", "百合", "耽美",
  "同人", "全彩", "单行本", "短篇", "长篇", "连载", "完结", "日常", "校园",
  "科幻", "奇幻", "魔法", "悬疑", "恐怖", "搞笑", "治愈", "热血", "冒险",
  "战斗", "运动", "美食", "音乐", "历史", "战争", "催眠", "调教", "凌辱",
  "露出", "触手", "怀孕", "修车", "无修", "无码",
  "韩漫", "国漫", "日漫", "港漫", "欧美", "黑白", "彩漫",
  "NTR", "BL", "GL", "H",
];

// 常见系列/IP 名词典（精确匹配标签名）：同人/漫画库里这类标签常代表整个系列，
// 单凭标题或条目数无法识别，靠词典直接定型。收的是用户库里高频出现的 IP 名。
const SERIES_WORDS = [
  "原神", "鸣潮", "明日方舟", "方舟", "碧蓝航线", "蔚蓝档案", "碧蓝档案",
  "偶像大师",
  "赛马娘", "公主连结", "公主连接", "FGO", "命运冠位指定", "崩坏3", "崩坏三",
  "崩坏星穹铁道", "星穹铁道", "绝区零", "东方", "东方project", "东方project系列",
  "少女前线", "舰队collection", "舰colle", "舰娘", "战双", "阴阳师",
  "咒术回战", "鬼灭之刃", "海贼王", "航海王", "火影忍者", "死神", "龙珠",
  "名侦探柯南", "柯南", "EVA", "新世纪福音战士", "进击的巨人", "东京喰种",
  "刀剑神域", "命运石之门", "Fate", "fate", "型月", "型月世界", "东方红魔乡",
  "舰C", "少前", "方舟", "乖离性", "崩坏学园", "碧蓝幻想", "偶像荣耀",
  "少女歌剧", "佐贺偶像是传奇", "变形金刚", "奥特曼", "哥斯拉", "初音未来",
  "VOCALOID", "vocaloid", "虚拟主播", "hololive", "Hololive", "彩虹社",
  "彩虹社nijisanji", "nijisanji", "海贼", "火影", "死神bleach", "bleach",
  "全职猎人", "钢之炼金术师", "银魂", "家庭教师", "犬夜叉", "灌篮高手",
  "棒球英豪", "足球小将", "足球小将翼", "网球王子", "排球少年", "黑子的篮球",
  "轻音少女", "幸运星", "凉宫春日", "魔法少女小圆", "叛逆的鲁路修", "机动战士高达",
  "高达", "钢弹", "新海诚", "吉卜力", "宫崎骏", "宝可梦", "口袋妖怪", "宠物小精灵",
  "数码宝贝", "精灵宝可梦", "妖怪手表", "怪物猎人", "塞尔达传说", "马里奥",
  "任天堂", "playstation", "最终幻想", "ff7", "ff14", "勇者斗恶龙", "王国之心",
  "生化危机", "寂静岭", "古墓丽影", "刺客信条", "孤岛惊魂", "使命召唤",
  "战地", "彩虹六号", "英雄联盟", "lol", "王者荣耀", "dota", "刀塔",
  "守望先锋", "星际争霸", "魔兽世界", "魔兽争霸", "暗黑破坏神", "炉石传说",
  "地下城与勇士", "dnf", "穿越火线", "cf", "剑网三", "剑网3", "天涯明月刀",
  "逆水寒", "梦幻西游", "大话西游", "诛仙", "完美世界", "斗罗大陆", "斗破苍穹",
  "全职高手", "一人之下", "狐妖小红娘", "刺客五六七", "罗小黑战记", "秦时明月",
  "灵笼", "凡人修仙传", "镇魂街", "镖人", "镖师", "火凤燎原", "西行纪",
  "大理寺日志", "时辰", "魔道祖师", "天官赐福", "陈情令", "山河令",
  "爱死机", "神偷奶爸", "小黄人", "驯龙高手", "冰雪奇缘", "疯狂动物城",
  "千与千寻", "你的名字", "天气之子", "铃芽之旅",
];

const stripExt = (name) => String(name).replace(/\.[^.\\/]+$/, "");

// 标题里成对括号/书名号中的名字 → 作者类标注（如「【banssee】女仆忤逆小队」）
const BRACKET_RE = /[【\[(（][^】\]）)]*[】\]）)]/g;

const titlesLower = (itemNames) =>
  (itemNames || []).map((n) => stripExt(n).toLowerCase()).filter(Boolean);

// 单条标题或整批标题共用一套启发式；ratio 由调用方决定（单条=全命中，批量=取半数）。
function classifyByTitles(name, titles, ratio) {
  const lower = name.toLowerCase();
  if (GENRE_WORDS.some((w) => lower === w.toLowerCase())) return "genre";
  // 常见系列/IP 名 → 系列（无需标题证据）
  if (SERIES_WORDS.some((w) => lower === w.toLowerCase())) return "series";
  if (!titles.length) return "";
  // 括号标注命中 → 作者（如【banssee】
  let bracketHits = 0;
  let plainHits = 0;
  for (const t of titles) {
    let inBracket = false;
    BRACKET_RE.lastIndex = 0;
    let m;
    while ((m = BRACKET_RE.exec(t))) {
      if (m[0].includes(lower)) {
        inBracket = true;
        break;
      }
    }
    if (inBracket) bracketHits++;
    else if (t.includes(lower)) plainHits++;
  }
  if (bracketHits >= 1 && bracketHits / titles.length >= ratio) return "author";
  if (plainHits >= 1 && plainHits / titles.length >= ratio) return "character";
  return "";
}

// 批量推断（标签页浏览用）：题材词库→genre；半数以上标题命中→author/character；条目≥6→series
export function inferTagKind(tagName, itemNames = []) {
  const name = String(tagName || "").trim();
  if (!name) return "";
  const titles = titlesLower(itemNames);
  const hit = classifyByTitles(name, titles, 0.5);
  if (hit) return hit;
  if (titles.length >= 6) return "series";
  return "";
}

// 创建时推断（编辑弹窗用）：拿当前条目标题做单条判断
export function inferTagKindFromTitle(tagName, itemTitle = "") {
  const name = String(tagName || "").trim();
  if (!name) return "";
  return classifyByTitles(name, [stripExt(String(itemTitle || "")).toLowerCase()], 1);
}