<script setup>
import { computed, ref, watch } from "vue";
import { useNotification } from "naive-ui";
import { invoke } from "@tauri-apps/api/core";
import { useTags } from "../store/tags";
import { useSettings } from "../store/settings";
import { covers } from "../store/browserCache";
import { tagColor, hexToRgba } from "../utils/tagColor";
import { openSearchItem } from "../utils/open";
import {
  closeContextMenu,
  openContextMenu,
  openGenericMenu,
  requestConfirm,
} from "../utils/contextMenu";
import { useItemActions } from "../utils/itemActions";
import { useCellLongPress } from "../utils/longPress";
import { useLazyCovers } from "../utils/lazyCovers";
import { createScrollRestorer } from "../utils/scrollAnchor";
import { entranceActive, markEntrancePlayed } from "../utils/entranceOnce";
import { TAG_KINDS, TAG_KIND_ORDER, kindLabel, inferTagKind } from "../utils/tagKind";
import Icon from "./Icon.vue";
import MediaCover from "./MediaCover.vue";

defineOptions({ name: "TagBrowse" });

const tagsStore = useTags();
const settings = useSettings();
const notification = useNotification();
const router = useRouter();
const { editTags } = useItemActions();

// 多选标签（AND 交集）：勾选多个标签，展示同时拥有全部选中标签的条目。
const selectedTags = ref([]); // TagRow[]（来自 tagsStore.allTags 的引用）
const items = ref([]);
const parents = ref([]);
const loading = ref(false);
const renamingId = ref(null);
const renameValue = ref("");
const filterText = ref(""); // 标签云即时筛选（客户端）
const previewTag = ref(null); // 未筛选时，展示“精选”最高频标签的条目
let lastPreviewAt = 0;

const entering = entranceActive("tags");
const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });

/* ===== 标签云派生 ===== */
const sortedTags = computed(() =>
  [...tagsStore.allTags].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
);
const q = computed(() => filterText.value.trim().toLowerCase());
const cloudTags = computed(() =>
  q.value
    ? sortedTags.value.filter((t) => t.name.toLowerCase().includes(q.value))
    : sortedTags.value
);
const isSelected = (tag) => selectedTags.value.some((t) => t.id === tag.id);

/* ===== 标签类型（kind）：入库优先，未设置时按标题启发式推测 ===== */
const inferredKind = ref({}); // tagId -> kind（仅展示建议，不落库）
const kindOf = (tag) => tag.kind || inferredKind.value[tag.id] || "";

// 一次拉取所有「未定类型」标签的条目名样本 → 前端推断
const ensureKindHints = async () => {
  const needId = tagsStore.allTags.filter((t) => !t.kind).map((t) => t.id);
  if (!needId.length) return;
  try {
    const samples = (await invoke("get_tag_samples", { tagIds: needId })) || [];
    const next = { ...inferredKind.value };
    for (const s of samples) {
      const tag = tagsStore.allTags.find((t) => t.id === s.tagId);
      if (tag && !tag.kind) next[s.tagId] = inferTagKind(tag.name, s.names || []);
    }
    inferredKind.value = next;
  } catch (error) {
    console.error("TAGS-KIND-HINTS-FAIL", error);
  }
};

const kindHead = (kind) => TAG_KINDS.find((k) => k.value === kind) || TAG_KINDS[TAG_KINDS.length - 1];

// 按 kind 分组（顺序：作者→系列→角色→题材→其它），供左侧面板分区展示
const kindGroups = computed(() => {
  const groups = TAG_KIND_ORDER.map((value) => ({
    value,
    label: kindHead(value).label,
    tags: [],
  }));
  for (const tag of cloudTags.value) {
    const g = groups.find((x) => x.value === kindOf(tag));
    if (g && !g.tags.includes(tag)) g.tags.push(tag);
  }
  return groups.filter((g) => g.tags.length);
});

/* ===== 分组折叠 ===== */
// 标签页初次进入时收起所有分组，用户点击分组标题后再展开。
const collapsedKinds = ref(new Set(TAG_KIND_ORDER));
const toggleKindGroup = (kind) => {
  const next = new Set(collapsedKinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  collapsedKinds.value = next;
};
// 筛选时始终展开，避免匹配被折叠组藏住
const isKindCollapsed = (kind) =>
  !q.value && collapsedKinds.value.has(kind);

// 计数 → 字号层级：重标签（≥5）更大，轻标签轻巧收起
const tierOf = (tag) => (tag.count >= 5 ? "lg" : tag.count >= 2 ? "md" : "sm");

// 每枚标签固定色（哈希推导），经 --c 供 CSS 的 color-mix 调制
const chipStyle = (tag, i) => ({
  "--c": tagColor(tag.name),
  animationDelay: entering ? `${Math.min(i * 32, 420)}ms` : undefined,
});
const tagChipStyle = (name) => {
  const c = tagColor(name);
  return { color: c, background: hexToRgba(c, 0.12), borderColor: hexToRgba(c, 0.4) };
};

/* ===== 多选筛选 ===== */
// 未筛选时，加载“精选”：条目最多的那个标签下的内容，填充浏览态
const loadPreview = async () => {
  const top = [...tagsStore.allTags].sort((a, b) => b.count - a.count)[0];
  if (!top) {
    items.value = [];
    parents.value = [];
    previewTag.value = null;
    return;
  }
  // 短时间内的同标签重访不重复拉取（避免反复切页时刷新闪烁）
  if (previewTag.value?.id === top.id && items.value.length && Date.now() - lastPreviewAt < 8000) {
    return;
  }
  loading.value = true;
  try {
    const res = await invoke("get_tag_items", { tagIds: [top.id], limit: 100 });
    previewTag.value = top;
    items.value = res.items || [];
    parents.value = res.parents || [];
    lastPreviewAt = Date.now();
  } catch (error) {
    console.error("TAGS-PREVIEW-FAIL", error);
    items.value = [];
    parents.value = [];
  } finally {
    loading.value = false;
    observeCovers();
  }
};

const refreshItems = async () => {
  if (!selectedTags.value.length) {
    previewTag.value = null; // 强制重拉精选，确保回到浏览态时数据干净
    await loadPreview();
    return;
  }
  loading.value = true;
  try {
    const res = await invoke("get_tag_items", {
      tagIds: selectedTags.value.map((t) => t.id),
      limit: 100,
    });
    items.value = res.items || [];
    parents.value = res.parents || [];
  } catch (error) {
    console.error("TAGS-GET-ITEMS-FAIL", error);
    items.value = [];
    parents.value = [];
  } finally {
    loading.value = false;
    observeCovers();
  }
};

const toggleTag = async (tag) => {
  const i = selectedTags.value.findIndex((t) => t.id === tag.id);
  if (i >= 0) selectedTags.value.splice(i, 1);
  else selectedTags.value.push(tag);
  await refreshItems();
};

const clearSelection = () => {
  selectedTags.value = [];
  refreshItems();
};

const resultsVisible = computed(() => selectedTags.value.length > 0 || !!previewTag.value);

/* ===== 结果分组（与搜索页同款三段式） ===== */
const extraOf = (row) => row.extra || {};

const nodeShape = (row, favName, kind, ext) => ({
  name: row.name,
  key: row.pathKey,
  path: row.pathKey,
  dir: row.parentPath || row.pathKey,
  folder: favName,
  kind,
  ext,
  count: extraOf(row).count ?? 0,
  videoCount: extraOf(row).videoCount ?? 0,
  imageCount: extraOf(row).imageCount ?? 0,
  childCount: extraOf(row).childCount ?? 0,
  children: [],
  files: [],
});

const kindOfRow = (row) =>
  row.kind === "group"
    ? { kind: "group", ext: "group" }
    : row.mediaType === "video"
      ? { kind: "video-folder", ext: "video" }
      : row.mediaType === "image"
        ? { kind: "image-folder", ext: "image" }
        : { kind: "media-folder", ext: "media" };

const tagComics = computed(() =>
  items.value
    .filter((r) => r.kind === "comic")
    .map((r) => ({
      name: r.name,
      key: r.pathKey,
      path: r.pathKey,
      pathKey: r.pathKey,
      ext: r.ext || "",
      kind: "comic",
      folder: r.folder,
      dir: r.parentPath || r.pathKey,
    }))
    .sort(byName)
);

const tagPacks = computed(() =>
  items.value
    .filter((r) => r.kind === "pack" || r.kind === "group")
    .map((r) => {
      const k = r.kind === "group" ? { kind: "group", ext: "group" } : kindOfRow(r);
      return nodeShape(r, r.folder || "", k.kind, k.ext);
    })
    .sort(byName)
);

const tagFileGroups = computed(() => {
  const groups = new Map();
  for (const f of items.value) {
    if (f.kind !== "video" && f.kind !== "image") continue;
    const parentKey = f.parentPath || "";
    if (!groups.has(parentKey)) {
      const parent = parents.value.find((p) => p.pathKey === parentKey);
      groups.set(parentKey, {
        parentPath: parentKey,
        parentName:
          parent?.name ||
          String(parentKey).split(/[\\/]/).filter(Boolean).pop() ||
          "未知目录",
        files: [],
      });
    }
    groups.get(parentKey).files.push(f);
  }
  const list = Array.from(groups.values());
  for (const g of list) g.files.sort(byName);
  return list.sort((a, b) =>
    a.parentName.localeCompare(b.parentName, "zh-Hans-CN", { numeric: true })
  );
});

/* ===== 标签重命名 / 删除 ===== */
const startRename = (tag) => {
  renamingId.value = tag.id;
  renameValue.value = tag.name;
};

const commitRename = async () => {
  if (renamingId.value == null) return;
  const name = renameValue.value.trim().replace(/\s+/g, " ");
  const id = renamingId.value;
  renamingId.value = null;
  if (!name) return;
  try {
    await tagsStore.renameTag(id, name);
    // 更新选中项显示名，并刷新结果里的 matchedTags 名称
    const sel = selectedTags.value.find((t) => t.id === id);
    if (sel) sel.name = name;
    if (selectedTags.value.length) await refreshItems();
  } catch (error) {
    console.error("TAGS-RENAME-FAIL", error);
    notification.error({
      title: "重命名失败",
      content: error?.message || "请检查标签名是否已被占用",
      duration: 2500,
    });
  }
};

const requestDeleteTag = (tag) => {
  requestConfirm({
    id: "delete-tag",
    label: "删除标签",
    message: `确认删除标签「${tag.name}」？所有条目上的该标签都会被移除。`,
    confirmLabel: "删除",
    onConfirm: async () => {
      try {
        await tagsStore.deleteTag(tag.id);
        const i = selectedTags.value.findIndex((t) => t.id === tag.id);
        if (i >= 0) selectedTags.value.splice(i, 1);
        await refreshItems();
      } catch (error) {
        console.error("TAGS-DELETE-FAIL", error);
        notification.error({ title: "删除失败", content: "请重试", duration: 2500 });
      }
    },
  });
};

/* ===== 右键 / 长按 ===== */
const openTagMenu = (tag, x, y) => {
  const currentKind = kindOf(tag);
  const setKind = async (kind) => {
    if (kind === currentKind || kind === kindOf(tag)) return; // 已为此类型，无需写库
    try {
      await tagsStore.setTagKind(tag.id, kind);
    } catch (error) {
      console.error("TAGS-SET-KIND-FAIL", error);
    }
  };
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "toggle",
        label: isSelected(tag) ? "取消选择" : "选择标签",
        icon: "check",
        onSelect: () => {
          closeContextMenu();
          toggleTag(tag);
        },
      },
      ...TAG_KINDS.map((k) => ({
        id: `kind-${k.value || "none"}`,
        label: `类型 · ${k.label}${currentKind === k.value ? "（当前）" : ""}`,
        icon: k.icon,
        onSelect: async () => {
          closeContextMenu();
          await setKind(k.value);
          tagsStore.loadTags();
        },
      })),
      {
        id: "rename",
        label: "重命名",
        icon: "pencil",
        onSelect: () => {
          closeContextMenu();
          startRename(tag);
        },
      },
      {
        id: "delete",
        label: "删除标签",
        icon: "trash",
        danger: true,
        // 不先关菜单：requestConfirm 在菜单原位渲染确认面板（与 itemActions 删除同款流程）
        onSelect: () => requestDeleteTag(tag),
      },
    ],
  });
};

const itemMap = new Map();
const rebuildItemMap = () => {
  itemMap.clear();
  for (const i of items.value) itemMap.set(i.pathKey, i);
};
watch(items, rebuildItemMap, { immediate: true });

const openItemMenu = (item, x, y) => {
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "open",
        label: "打开",
        icon: "book-open",
        onSelect: () => {
          closeContextMenu();
          openTagItem(item);
        },
      },
      {
        id: "tags",
        label: "编辑标签",
        icon: "tag",
        onSelect: () => editTags(item),
      },
    ],
  });
};

const onPageContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target?.closest?.(".tag-chip, .book-cell, .file-hit");
  if (!cell) {
    openGenericMenu(e.clientX, e.clientY);
    return;
  }
  if (cell.classList.contains("tag-chip")) {
    const id = Number(cell.dataset.id);
    const hit = tagsStore.allTags.find((t) => t.id === id);
    if (hit) openTagMenu(hit, e.clientX, e.clientY);
    else openGenericMenu(e.clientX, e.clientY);
  } else {
    const hit = itemMap.get(cell.dataset.key);
    if (hit) openItemMenu(hit, e.clientX, e.clientY);
    else openGenericMenu(e.clientX, e.clientY);
  }
};

const longPress = useCellLongPress({
  selector: ".tag-chip, .book-cell, .file-hit",
  resolveHit: (cell) => {
    if (cell.classList.contains("tag-chip")) {
      const id = Number(cell.dataset.id);
      return tagsStore.allTags.find((t) => t.id === id) || null;
    }
    return itemMap.get(cell.dataset.key) || null;
  },
  onHit: (hit, x, y) => {
    if (hit.id !== undefined && hit.name !== undefined && hit.count !== undefined) openTagMenu(hit, x, y);
    else openItemMenu(hit, x, y);
  },
  onEmpty: (x, y) => openGenericMenu(x, y),
});

/* ===== 封面懒加载 ===== */
const lazyCovers = useLazyCovers({
  selector: ".tag-page .book-cover, .tag-page .media-cover",
});
const observeCovers = () => lazyCovers.observe();

// 标签页在桌面端由「标签索引」和「结果区」分别滚动，移动端则由整页滚动。
const pageRef = ref(null);
const cloudRef = ref(null);
const resultsRef = ref(null);
const tagScroll = createScrollRestorer([
  {
    element: () => pageRef.value,
    stateKey: "tags:page",
    anchorKey: "tags:page",
    anchorSelector: ".book-cell[data-key], .file-hit[data-key]",
  },
  { element: () => cloudRef.value, stateKey: "tags:cloud", anchor: false },
  {
    element: () => resultsRef.value,
    stateKey: "tags:results",
    anchorKey: "tags:results",
    anchorSelector: ".book-cell[data-key], .file-hit[data-key]",
  },
]);
const saveTagScroll = () => tagScroll.capture();

const openTagItem = (item) => {
  // 在路由切换前主动捕获一次，避免 keep-alive 隐藏过程中 scrollTop 被浏览器复位。
  tagScroll.checkpoint();
  return openSearchItem(item, { back: "tags" });
};

onMounted(async () => {
  await tagsStore.loadTags();
  ensureKindHints();
  if (!selectedTags.value.length) await loadPreview();
  observeCovers();
  markEntrancePlayed("tags");
});

onActivated(async () => {
  tagScroll.suspend();
  await tagsStore.loadTags();
  ensureKindHints();
  if (!selectedTags.value.length) await loadPreview();
  await tagScroll.restoreAfterRender();
  observeCovers();
});

onDeactivated(() => {
  closeContextMenu();
  // keep-alive 隐藏时浏览器可能已经把容器的 scrollTop 钳回 0，
  // 位置与锚点已在滚动事件中保存，此处不要再读取被重置后的值覆盖它。
  tagScroll.suspend();
  lazyCovers.reset();
});

onUnmounted(() => {
  lazyCovers.reset();
});
</script>

<template>
  <div
    class="tag-page"
    ref="pageRef"
    @scroll.passive="saveTagScroll"
    @contextmenu="onPageContextMenu"
    @touchstart="longPress.onTouchStart"
    @touchmove="longPress.onTouchMove"
    @touchend="longPress.onTouchEnd"
    @touchcancel="longPress.onTouchCancel"
  >
    <!-- 结果区状态头：常显，布局固定在顶部，不随内容滚动 -->
    <div v-if="tagsStore.allTags.length" class="sel-bar" :class="{ 'is-browsing': !selectedTags.length }">
      <span class="sel-intro">
        <Icon :id="selectedTags.length ? 'layers' : 'sparkles'" :size="13" />
        <template v-if="selectedTags.length">
          <span class="mono">已选 {{ selectedTags.length }}</span>
          <span class="sel-mode mono">AND 交集</span>
        </template>
        <template v-else>
          <span class="mono">精选 · {{ previewTag?.name || '—' }}</span>
        </template>
      </span>
      <div v-if="selectedTags.length" class="sel-chips">
        <button
          v-for="t in selectedTags"
          :key="t.id"
          type="button"
          class="sel-mini"
          :style="tagChipStyle(t.name)"
          :aria-label="`取消选择标签 ${t.name}`"
          @click="toggleTag(t)"
        >
          <Icon id="check" :size="10" class="sel-mini-check" />
          {{ t.name }}
        </button>
      </div>
      <div class="sel-actions">
        <span class="sel-hit mono">
          {{ loading ? "…" : selectedTags.length ? `命中 ${items.length} 条` : `${items.length} 条` }}
        </span>
        <button v-if="selectedTags.length" type="button" class="sel-clear" @click="clearSelection">
          <Icon id="x" :size="12" />
          清空
        </button>
      </div>
    </div>

    <!-- 两栏工作区：左侧标签索引（固定），右侧结果（独立滚动） -->
    <div class="tag-workspace">
      <aside class="tag-controls" aria-label="标签筛选">
        <!-- 标签索引 -->
        <section
          class="cloud"
          :class="{ 'has-filter': !!filterText }"
          title="点击标签可多选组合筛选"
        >
          <div v-if="tagsStore.allTags.length" class="cloud-head">
            <span class="cloud-title mono">标签索引</span>
            <div class="cloud-filter">
              <Icon id="filter" :size="13" class="cloud-filter-ico" />
              <input
                v-model="filterText"
                class="cloud-filter-input mono"
                placeholder="筛选标签"
                aria-label="筛选标签"
                spellcheck="false"
                @keydown.esc="filterText = ''"
              />
              <button
                v-if="filterText"
                type="button"
                class="cloud-filter-clear"
                title="清空"
                aria-label="清空标签筛选"
                @click="filterText = ''"
              >
                <Icon id="x" :size="11" />
              </button>
            </div>
            <span v-if="filterText" class="cloud-filter-count mono">{{ cloudTags.length }} 条</span>
          </div>

          <div v-if="cloudTags.length" ref="cloudRef" class="cloud-grid" @scroll.passive="saveTagScroll">
            <section v-for="g in kindGroups" :key="g.value" class="kind-group">
              <button
                type="button"
                class="kind-head"
                :aria-expanded="!isKindCollapsed(g.value)"
                @click="toggleKindGroup(g.value)"
              >
                <Icon id="chevron-right" :size="13" class="kind-chev" />
                <span class="kind-label mono">{{ g.label }}</span>
                <span class="kind-count mono">{{ g.tags.length }}</span>
                <span class="kind-rule"></span>
              </button>
              <div class="kind-chips" :class="{ collapsed: isKindCollapsed(g.value) }">
                <button
                  v-for="(tag, i) in g.tags"
                  :key="tag.id"
                  type="button"
                  class="tag-chip"
                  :class="[`t-${tierOf(tag)}`, { selected: isSelected(tag), 'chip-in': entering }]"
                  :style="chipStyle(tag, i)"
                  :data-id="tag.id"
                  :aria-pressed="isSelected(tag)"
                  :title="`${kindLabel(kindOf(tag))} · ${tag.count} 条目`"
                  @click="toggleTag(tag)"
                >
                  <template v-if="renamingId === tag.id">
                    <input
                      v-model="renameValue"
                      class="tag-rename-input"
                      autofocus
                      aria-label="重命名标签"
                      spellcheck="false"
                      @click.stop
                      @focus="$event.target.select()"
                      @keydown.enter="commitRename"
                      @keydown.esc="renamingId = null"
                      @blur="commitRename"
                    />
                  </template>
                  <template v-else>
                    <span class="chip-hole"></span>
                    <span class="chip-name">{{ tag.name }}</span>
                    <span class="chip-count mono">{{ tag.count }}</span>
                    <span v-if="isSelected(tag)" class="chip-check">
                      <Icon id="check" :size="10" :stroke-width="3" />
                    </span>
                  </template>
                </button>
              </div>
            </section>
          </div>

          <div v-else-if="tagsStore.allTags.length" class="cloud-empty">
            <Icon id="search" :size="16" />
            <span class="mono">没有匹配的标签 · {{ q }}</span>
            <button class="cloud-empty-reset" @click="filterText = ''">
              <Icon id="x" :size="11" /> 清除筛选
            </button>
          </div>

          <div v-else class="first-empty">
            <div class="first-empty-glyph" aria-hidden="true">签</div>
            <p class="first-empty-title">还没有任何标签</p>
            <p class="first-empty-sub">
              在书架或搜索页对任意条目右键 / 长按，选择「编辑标签」，即可开始建立你的索引。
            </p>
            <button class="first-empty-btn" @click="router.push('/')">
              <Icon id="book-open" :size="14" />
              去书架看看
            </button>
          </div>
        </section>
      </aside>

      <main ref="resultsRef" class="tag-results" @scroll.passive="saveTagScroll">
        <!-- 条目结果（浏览态=精选 · 筛选态=交集） -->
        <template v-if="resultsVisible">
          <div v-if="loading" class="grid-loading">
            <div v-for="i in 8" :key="i" class="cover-skeleton"></div>
          </div>

          <template v-else-if="items.length">
            <ul class="book-grid">
              <li
                v-for="book in tagComics"
                :key="book.key"
                class="book-cell"
                :data-key="book.key"
                @click="longPress.onCellClick(() => openTagItem(book))"
              >
                <div class="book-cover" :data-key="book.key" data-kind="comic">
                  <img
                    v-if="covers[book.key]"
                    :src="covers[book.key]"
                    class="book-cover-img"
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="book-cover-ph"><Icon id="book-open" :size="34" /></span>
                  <template v-if="settings.showSource">
                    <span class="book-ext mono">{{ book.ext.toUpperCase() }}</span>
                    <span v-if="book.folder" class="book-folder mono">{{ book.folder }}</span>
                  </template>
                </div>
                <div class="book-name">
                  <n-ellipsis :tooltip="false">{{ book.name }}</n-ellipsis>
                </div>
              </li>
            </ul>

            <div v-if="tagPacks.length" class="sec-head">
              <span class="sec-tick"></span>
              <span class="sec-title mono">目录</span>
              <span class="sec-count mono">{{ tagPacks.length }}</span>
              <span class="sec-rule"></span>
            </div>
            <ul class="book-grid">
              <li
                v-for="(item, i) in tagPacks"
                :key="item.key"
                class="book-cell"
                :data-key="item.key"
                @click="longPress.onCellClick(() => openTagItem(item))"
              >
                <MediaCover
                  :kind="item.kind"
                  :ext="item.ext"
                  :count="item.count"
                  :child-count="item.childCount"
                  :video-count="item.videoCount"
                  :image-count="item.imageCount"
                  :index="i"
                  :folder="item.folder"
                  :src="covers[item.key]"
                  :meta="settings.showSource"
                  :data-key="item.key"
                  :data-kind="item.kind"
                />
                <div class="book-name">
                  <n-ellipsis :tooltip="false">{{ item.name }}</n-ellipsis>
                </div>
              </li>
            </ul>

            <template v-for="(group, g) in tagFileGroups" :key="group.parentPath">
              <div class="sec-head">
                <span class="sec-tick"></span>
                <span class="sec-title mono">文件 · 在「{{ group.parentName }}」中</span>
                <span class="sec-count mono">{{ group.files.length }}</span>
                <span class="sec-rule"></span>
              </div>
              <ul class="file-hit-list">
                <li
                  v-for="f in group.files"
                  :key="f.pathKey"
                  class="file-hit"
                  :data-key="f.pathKey"
                  @click="longPress.onCellClick(() => openTagItem(f))"
                >
                  <span class="file-hit-ico">
                    <Icon :id="f.kind === 'video' ? 'film' : 'image'" :size="16" />
                  </span>
                  <span class="file-hit-name">{{ f.name }}</span>
                  <span v-if="settings.showSource" class="file-hit-ext mono">{{ (f.ext || '').toUpperCase() }}</span>
                  <Icon id="chevron-right" :size="14" class="file-hit-arrow" />
                </li>
              </ul>
            </template>
          </template>

          <div v-else-if="selectedTags.length" class="empty-state">
            <Icon id="tag" :size="34" />
            <p class="empty-title">没有同时拥有这些标签的条目</p>
            <p class="empty-sub">减少选择的标签，或在书架 / 搜索页为条目补上「编辑标签」</p>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.tag-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  padding: 84px clamp(18px, 2.4vw, 34px) 60px;
  background:
    radial-gradient(60% 45% at 85% -5%, var(--accent-soft), transparent 60%),
    radial-gradient(45% 40% at -10% 30%, color-mix(in srgb, var(--accent-2) 8%, transparent), transparent 60%),
    var(--bg-0);
}

:global(.theme-dark) .tag-page {
  background: var(--bg-0);
}

/* ===== 标签索引面板 ===== */
/* 顶部不再有独立刊头；筛选框并入“标签索引”面板头部，与面板框融为一体 */
.cloud-filter {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--text-1) 12%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg-2) 55%, var(--panel));
  transition: border-color 0.25s, box-shadow 0.25s, background 0.25s;

  &:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: var(--bg-2);
  }

  .cloud-filter-ico {
    color: var(--text-3);
    flex-shrink: 0;
  }

  .cloud-filter-input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--mono);
    letter-spacing: 0.05em;

    &::placeholder {
      color: var(--text-3);
    }
  }

  .cloud-filter-clear {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 50%;
    background: color-mix(in srgb, var(--text-1) 10%, transparent);
    color: var(--text-2);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.2s, color 0.2s;

    &:hover {
      background: var(--accent-soft);
      color: var(--accent);
    }
  }
}

.tag-workspace {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(224px, 256px) minmax(0, 1fr);
  gap: clamp(16px, 2vw, 28px);
  margin-top: 16px;
}

.tag-controls,
.tag-results {
  min-width: 0;
}

/* 桌面端：左栏与状态头由两栏布局固定在顶部，不依赖 sticky（WebView2 中 sticky 在此容器内不可靠） */
.tag-controls {
  position: static;
}

/* ===== 已选标签条（常显状态头） ===== */
.sel-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px 16px;
  margin: 0 0 16px;
  padding: 10px 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: var(--shadow-1);
  animation: selIn 0.4s var(--ease-spring) both;

  /* 浏览态（未筛选）：状态头弱化，避免误以为处于筛选态 */
  &.is-browsing {
    border-color: var(--line);
    box-shadow: none;

    .sel-intro svg {
      color: var(--text-3);
    }
  }
}

@keyframes selIn {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.sel-intro {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 0.2em;
  white-space: nowrap;

  svg {
    color: var(--accent);
  }
}

.sel-mode {
  padding-left: 7px;
  border-left: 1px solid var(--line-strong);
  color: var(--text-2);
  letter-spacing: 0.12em;
}

.sel-chips {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  mask-image: linear-gradient(to right, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%);
  padding: 2px 10px;

  &::-webkit-scrollbar {
    display: none;
  }
}

.sel-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: transform 0.25s var(--ease-spring), filter 0.2s;

  .sel-mini-check {
    flex-shrink: 0;
  }

  &:hover {
    transform: translateY(-1px) scale(1.03);
    filter: brightness(1.08);
  }
}

.sel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sel-hit {
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--text-3);
  white-space: nowrap;
}

.sel-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.2s, background 0.2s;

  &:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
}

/* ===== 标签云 ===== */
.cloud {
  position: relative;
  z-index: 2;
  width: 100%;
  margin-bottom: 28px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  box-shadow: 0 14px 44px color-mix(in srgb, var(--text-1) 4%, transparent);
  backdrop-filter: blur(14px);
}

.cloud-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
}

.cloud-title {
  color: var(--text-2);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  white-space: nowrap;
  flex-shrink: 0;
}

.cloud-filter-count {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.08em;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 分组滚动区：各 kind 分区纵向排列 */
.cloud-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-content: start;
}

/* ===== 类型分组 ===== */
.kind-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.kind-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  margin: 0 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  &:hover .kind-label {
    color: var(--text-1);
  }

  .kind-chev {
    color: var(--text-3);
    flex-shrink: 0;
    transition: transform 0.25s var(--ease-out);
  }

  &[aria-expanded="true"] .kind-chev {
    transform: rotate(90deg);
  }
}

.kind-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.24em;
  color: var(--text-3);
  text-transform: uppercase;
  white-space: nowrap;
  transition: color 0.2s;
}

.kind-count {
  display: grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--text-2);
  font-size: 9px;
  flex-shrink: 0;
}

.kind-rule {
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* 芯片列表：按标签内容自适应宽度并自动换行；折叠时收起 */
.kind-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  transition:
    max-height 0.3s var(--ease-out),
    opacity 0.25s var(--ease-out);
  max-height: 1200px;
  overflow: hidden;

  &.collapsed {
    max-height: 0;
    opacity: 0;
  }
}

.tag-chip {
  --c: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: auto;
  max-width: 100%;
  min-width: 0;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--c) 26%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--c) 5%, var(--bg-2));
  color: var(--text-1);
  cursor: pointer;
  font-family: inherit;
  font-weight: 600;
  font-size: 12px;
  text-align: left;
  transition:
    transform 0.3s var(--ease-spring),
    border-color 0.25s,
    background 0.25s,
    box-shadow 0.3s var(--ease-out);

  &.chip-in {
    opacity: 0;
    transform: translateY(10px);
    animation: chipRise 0.55s var(--ease-spring) both;
  }

  &:hover {
    transform: translateY(-2px) scale(1.02);
    border-color: color-mix(in srgb, var(--c) 62%, transparent);
    background: color-mix(in srgb, var(--c) 10%, var(--bg-2));
    box-shadow: 0 10px 26px color-mix(in srgb, var(--c) 20%, transparent);
  }

  &:active {
    transform: translateY(0) scale(0.97);
  }

  &.selected {
    background: color-mix(in srgb, var(--c) 16%, var(--bg-2));
    border-color: color-mix(in srgb, var(--c) 62%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--c) 34%, transparent),
      0 8px 22px color-mix(in srgb, var(--c) 20%, transparent);
  }

  &.t-sm {
    font-size: 11px;

    .chip-hole {
      width: 4px;
      height: 4px;
    }
  }

  &.t-md {
    font-size: 11.5px;

    .chip-hole {
      width: 5px;
      height: 5px;
    }
  }

  &.t-lg {
    font-size: 12.5px;
    font-weight: 700;

    .chip-hole {
      width: 6px;
      height: 6px;
    }
  }
}

@keyframes chipRise {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 冲孔细节：标签像一枚实物纸签 */
.chip-hole {
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--c) 62%, transparent);
  background: var(--bg-0);
  flex-shrink: 0;
}

.chip-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-count {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--c) 10%, transparent);
  font-size: 8.5px;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--c) 78%, var(--text-3));
  flex-shrink: 0;
}

.chip-check {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-1);
  color: var(--bg-0);
  flex-shrink: 0;
  animation: chipIn 0.3s var(--ease-spring) both;
}

@keyframes chipIn {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.tag-rename-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--c) 65%, transparent);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 13px;
  outline: none;
  font-family: inherit;
}

/* 云空态 / 首启空态 */
.cloud-empty {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  color: var(--text-3);
  font-size: 12.5px;
  width: 100%;
  justify-content: center;

  .cloud-empty-reset {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border: none;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11.5px;
    cursor: pointer;
    transition: filter 0.2s;

    &:hover {
      filter: brightness(1.06);
    }
  }
}

.first-empty {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 26px 0 30px;

  .first-empty-glyph {
    font-family: var(--serif);
    font-size: clamp(88px, 14vw, 160px);
    font-weight: 900;
    line-height: 1;
    color: transparent;
    -webkit-text-stroke: 1.5px color-mix(in srgb, var(--text-1) 12%, transparent);
  }

  .first-empty-title {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-1);
  }

  .first-empty-sub {
    font-size: 13px;
    color: var(--text-3);
    line-height: 1.8;
    max-width: 460px;
  }

  .first-empty-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 18px;
    margin-top: 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel);
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    backdrop-filter: blur(12px);
    transition: all 0.25s var(--ease-out);

    &:hover {
      color: var(--accent);
      border-color: var(--accent);
      transform: translateY(-2px);
    }
  }
}

/* ===== 结果分区标题 ===== */
.sec-head {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 18px;

  .sec-tick {
    width: 22px;
    height: 2px;
    background: var(--accent-grad);
    flex-shrink: 0;
  }

  .sec-title {
    font-size: 11px;
    letter-spacing: 0.24em;
    color: var(--text-3);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .sec-count {
    min-width: 22px;
    height: 18px;
    display: grid;
    place-items: center;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
  }

  .sec-rule {
    flex: 1;
    height: 1px;
    background: var(--line-strong);
  }
}

/* ===== 条目结果（复用搜索页样式） ===== */
.book-grid {
  position: relative;
  z-index: 2;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 30px 18px;
  padding: 0;
  margin-bottom: 26px;
}

.book-cell {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.book-cover {
  position: relative;
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out);
  display: grid;
  place-items: center;
}

.book-cell:hover .book-cover {
  transform: translateY(-6px) scale(1.02);
  box-shadow: var(--shadow-2);
}

.book-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.book-cover-ph {
  color: var(--text-3);
  display: grid;
  place-items: center;
}

.book-ext {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.9);
  font-size: 9px;
  letter-spacing: 0.12em;
  backdrop-filter: blur(6px);
}

.book-folder {
  position: absolute;
  left: 8px;
  bottom: 8px;
  max-width: 55%;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.82);
  font-size: 9px;
  letter-spacing: 0.1em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(6px);
}

.book-name {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.35;
  text-align: center;
  padding: 0 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.file-hit-list {
  position: relative;
  z-index: 2;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  max-width: 720px;
  margin-bottom: 40px;
}

.file-hit {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-2);
  cursor: pointer;
  transition: border-color 0.25s, background 0.25s, transform 0.25s var(--ease-out);

  &:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 45%, var(--bg-2));
    transform: translateY(-2px);
  }
}

.file-hit-ico {
  display: grid;
  place-items: center;
  color: var(--text-3);
  flex-shrink: 0;
}

.file-hit-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-hit-ext {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.file-hit-arrow {
  color: var(--text-3);
  flex-shrink: 0;
}

/* 骨架屏 */
.grid-loading {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 30px 18px;
}

.cover-skeleton {
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  background: linear-gradient(100deg, var(--bg-2) 40%, color-mix(in srgb, var(--bg-2) 40%, var(--text-1) 8%) 50%, var(--bg-2) 60%);
  background-size: 200% 100%;
  animation: shimmer 1.6s infinite linear;
}

/* ===== 桌面端：顶栏 + 左栏固定，仅结果区滚动 ===== */
@media (min-width: 901px) {
  .tag-page {
    display: flex;
    flex-direction: column;
    overflow-y: hidden;
    padding-bottom: 0;
  }

  .sel-bar {
    flex-shrink: 0;
    height: 48px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: none;
    gap: 10px 14px;
    margin: 0 0 18px;
    padding: 10px 14px;
    border-radius: 14px;
  }

  .tag-workspace {
    flex: 1;
    min-height: 0;
    margin-top: 0;
  }

  .tag-controls {
    align-self: stretch;
  }

  .cloud {
    height: 100%;
    display: flex;
    flex-direction: column;
    margin-bottom: 0;
    padding: 12px;
    border-radius: 16px;
    overflow: hidden;
  }

  .cloud-head {
    flex-shrink: 0;
    gap: 10px;
  }

  .cloud-filter-count {
    font-size: 9.5px;
  }

  .cloud-grid {
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
    padding-right: 3px;
  }

  .tag-results {
    overflow-y: auto;
    min-height: 0;
    padding: 0 4px 56px 0;
  }

  .sel-intro {
    grid-area: auto;
  }

  .sel-chips {
    grid-area: auto;
    margin-inline: 0;
    padding-inline: 8px;
  }

  .sel-actions {
    grid-area: auto;
    gap: 10px;
  }

  .sel-hit {
    display: inline;
  }

  .tag-chip {
    min-height: 30px;
    padding-inline: 9px;
  }

  .book-grid,
  .grid-loading {
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 26px 14px;
  }

  .file-hit-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-width: none;
    gap: 10px;
  }
}

/* 空状态 */
.empty-state {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 30vh;
  color: var(--text-3);
  text-align: center;

  .empty-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-2);
    margin-top: 6px;
  }

  .empty-sub {
    font-size: 13px;
    max-width: 380px;
    line-height: 1.7;
  }
}

@media (max-width: 900px) {
  .tag-page {
    padding: 84px clamp(18px, 3.5vw, 34px) 92px;
  }

  .tag-workspace {
    display: block;
    margin-top: 20px;
  }

  .tag-controls {
    position: static;
  }

  .tag-results {
    padding-top: 0;
  }

  .cloud {
    max-width: none;
  }

  .cloud-grid {
    gap: 10px;
  }

  .sel-bar {
    margin-top: 0;
  }

  .book-grid,
  .grid-loading {
    /* 流式列数：按实际宽度自动算，任何尺寸的手机都≥3 列，无需按机型调 */
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 14px 8px;
  }
}

@media (max-width: 640px) {
  .tag-page {
    padding: 72px 14px 104px;
  }

  /* 浏览态的状态条在窄屏只是「精选 · X」，占屏又无操作价值，隐藏；
     一旦筛选（选中标签）它会重新出现 */
  .sel-bar.is-browsing {
    display: none;
  }

  .sel-bar {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "intro actions"
      "chips chips";
    gap: 7px 10px;
    margin: 10px 0 14px;
    padding: 8px 10px;
    border-radius: 13px;
  }

  .sel-intro {
    grid-area: intro;
  }

  .sel-chips {
    grid-area: chips;
    margin: 0 -2px;
    padding-inline: 2px;
    mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent 100%);
  }

  .sel-actions {
    grid-area: actions;
    gap: 7px;
  }

  .sel-mini {
    height: 30px;
    padding-inline: 10px;
  }

  .sel-clear {
    height: 30px;
    padding-inline: 8px;
  }

  .cloud {
    margin-bottom: 22px;
    padding: 10px;
    border-radius: 15px;
  }

  .cloud-head {
    margin: 0 0 9px;
  }

  .cloud-grid {
    gap: 8px;
  }

  .kind-chips {
    gap: 6px;
  }

  .kind-head {
    margin-top: 1px;
  }

  .tag-chip {
    min-height: 34px;
    padding-inline: 8px;
    border-radius: 9px;
  }

  .tag-chip:hover,
  .book-cell:hover .book-cover,
  .file-hit:hover {
    transform: none;
  }

  .book-name {
    display: none;
  }

  .sec-head {
    gap: 8px;
    margin-bottom: 13px;

    .sec-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .file-hit-list {
    gap: 6px;
    margin-bottom: 28px;
  }

  .file-hit {
    height: 44px;
    padding-inline: 12px;
  }
}

@media (max-width: 420px) {
  .sel-mode,
  .sel-hit {
    display: none;
  }

  .cloud-filter-count {
    font-size: 9px;
  }

  .chip-hole {
    display: none;
  }

}

/* ===== 触屏（hover:none）：删除无 hover 语义的悬浮/位移动画 =====
   窄屏旧块（≤640px）已对部分行/卡去位移，这里统一到「无悬停能力」
   判定，覆盖平板与窄桌面触屏；颜色/描边反馈、:active、chip 出现
   动画保留（chip 出现是点击交互反馈，MediaCover 自身已在组件内处理）。 */
@media (hover: none) {
  .sel-mini:hover,
  .tag-chip:hover,
  .book-cell:hover .book-cover,
  .file-hit:hover,
  .first-empty-btn:hover {
    transform: none;
  }
}
</style>
