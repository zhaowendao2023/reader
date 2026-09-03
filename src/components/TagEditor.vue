<script setup>
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useTags } from "../store/tags";
import { tagColor, hexToRgba } from "../utils/tagColor";
import { TAG_KINDS, inferTagKindFromTitle } from "../utils/tagKind";
import Icon from "./Icon.vue";

const tagsStore = useTags();

const selected = ref(new Set());
const input = ref("");
const saving = ref(false);
const errorMsg = ref("");
// 本会话新增标签的类型：name -> kind（创建时按标题自动推荐，可当场修改）
const newKinds = ref({});
const lastNewTag = ref("");

const itemName = computed(() => tagsStore.editingItem?.name || "");
const currentTags = computed(() =>
  Array.from(selected.value).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
);
const availableTags = computed(() =>
  tagsStore.allTags
    .filter((t) => !selected.value.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
);

const loadCurrent = async () => {
  if (!tagsStore.editingItem?.pathKey) return;
  try {
    const res = await invoke("get_item_tags", { pathKey: tagsStore.editingItem.pathKey });
    selected.value = new Set((res || []).map((t) => t.name));
  } catch (error) {
    console.error("TAGS-LOAD-ITEM-FAIL", error);
  }
};

watch(
  () => tagsStore.editorOpen,
  (open) => {
    errorMsg.value = "";
    if (open) {
      selected.value = new Set();
      input.value = "";
      newKinds.value = {};
      lastNewTag.value = "";
      loadCurrent();
    }
  },
  { immediate: true }
);

// 点选新标签类型：立即入库（该标签此前已随回车保存过，不能只改高亮）
const setNewTagKind = async (kind) => {
  const name = lastNewTag.value;
  if (!name) return;
  newKinds.value = { ...newKinds.value, [name]: kind };
  const tag = tagsStore.allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (tag) {
    try {
      await tagsStore.setTagKind(tag.id, kind);
    } catch (error) {
      console.error("TAGS-NEW-KIND-SET-FAIL", error);
    }
  }
};

// 保存后给「本会话新增的标签」补写类型（库内 kind 还是空才写，兜底）
const applyNewKinds = async (names) => {
  const entries = Object.entries(newKinds.value);
  if (!entries.length) return;
  for (const [name, kind] of entries) {
    if (!kind || !names.includes(name)) continue;
    const tag = tagsStore.allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (tag && !tag.kind) {
      try {
        await tagsStore.setTagKind(tag.id, kind);
      } catch (error) {
        console.error("TAGS-NEW-KIND-FAIL", error);
      }
    }
  }
};

const save = async (set) => {
  saving.value = true;
  errorMsg.value = "";
  try {
    await tagsStore.saveTags(Array.from(set));
    await applyNewKinds(Array.from(set));
  } catch (error) {
    // 保存失败回读当前库内状态，避免界面与库不一致
    console.error("TAGS-SAVE-RELOAD", error);
    errorMsg.value = "保存失败，请重试";
    loadCurrent();
  } finally {
    saving.value = false;
  }
};

const toggle = async (name) => {
  const next = new Set(selected.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selected.value = next;
  await save(next);
};

const addNew = async () => {
  const name = input.value.trim().replace(/\s+/g, " ");
  if (!name) return;
  input.value = "";
  // 全新标签：按当前条目标题推荐类型（括注→作者 / 标题正文→角色 / 题材词库→题材）
  const exists = tagsStore.allTags.some((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!exists) {
    newKinds.value = {
      ...newKinds.value,
      [name]: inferTagKindFromTitle(name, itemName.value),
    };
    lastNewTag.value = name;
  }
  const next = new Set(selected.value);
  next.add(name);
  selected.value = next;
  await save(next);
};

const onInputKeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addNew();
  }
};

const chipStyle = (name) => {
  const c = tagColor(name);
  return { color: c, background: hexToRgba(c, 0.12), borderColor: hexToRgba(c, 0.45) };
};
</script>

<template>
  <Teleport to="body">
    <transition name="tag-fade">
      <div v-if="tagsStore.editorOpen" class="tag-overlay" @mousedown.self="tagsStore.closeEditor()">
        <div class="tag-panel">
          <header class="tag-head">
            <div class="tag-head-ico"><Icon id="tag" :size="18" /></div>
            <div class="tag-head-txt">
              <div class="tag-title">编辑标签</div>
              <div class="tag-sub">{{ itemName }}</div>
            </div>
            <button class="tag-close" title="关闭" @click="tagsStore.closeEditor()">
              <Icon id="x" :size="16" />
            </button>
          </header>

          <div class="tag-current">
            <button
              v-for="t in currentTags"
              :key="t"
              class="tag-chip"
              :style="chipStyle(t)"
              @click="toggle(t)"
            >
              {{ t }}
              <Icon id="x" :size="11" class="tag-chip-x" />
            </button>
            <span v-if="!currentTags.length" class="tag-empty">还没有标签，点下方标签或输入添加</span>
          </div>

          <div class="tag-add">
            <input
              v-model="input"
              class="tag-input"
              placeholder="输入新标签，回车添加"
              spellcheck="false"
              @keydown="onInputKeydown"
            />
            <button class="tag-add-btn" :disabled="!input.trim()" title="添加" @click="addNew">
              <Icon id="plus" :size="15" />
            </button>
          </div>

          <div
            v-if="lastNewTag && newKinds[lastNewTag] !== undefined"
            class="tag-newkind"
          >
            <span class="tag-newkind-label mono">「{{ lastNewTag }}」类型</span>
            <div class="tag-newkind-opts">
              <button
                v-for="k in TAG_KINDS"
                :key="k.value || 'none'"
                type="button"
                class="tag-kind-opt"
                :class="{ active: newKinds[lastNewTag] === k.value }"
                @click="setNewTagKind(k.value)"
              >
                {{ k.label }}
              </button>
            </div>
            <span class="tag-newkind-hint mono">已按标题推荐，可改</span>
          </div>

          <div v-if="availableTags.length" class="tag-existing">
            <div class="tag-existing-title mono">全部标签 · {{ tagsStore.allTags.length }}</div>
            <div class="tag-existing-list">
              <button
                v-for="t in availableTags"
                :key="t.id"
                class="tag-chip tag-chip--ghost"
                :style="{ color: tagColor(t.name) }"
                @click="toggle(t.name)"
              >
                {{ t.name }}
                <span class="tag-count mono">{{ t.count }}</span>
              </button>
            </div>
          </div>

          <div v-if="errorMsg" class="tag-error">{{ errorMsg }}</div>

          <footer class="tag-foot">
            <span v-if="saving" class="tag-saving mono">保存中…</span>
            <button class="tag-done" @click="tagsStore.closeEditor()">完成</button>
          </footer>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped lang="scss">
.tag-overlay {
  position: fixed;
  inset: 0;
  z-index: 9990;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(6px);
  padding: 20px;
}

.tag-panel {
  width: min(460px, 92vw);
  max-height: min(620px, 86vh);
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  border-radius: 18px;
  border: 1px solid var(--line-strong);
  background: var(--panel-solid);
  box-shadow: var(--shadow-2);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tag-head {
  display: flex;
  align-items: center;
  gap: 12px;

  .tag-head-ico {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .tag-head-txt {
    flex: 1;
    min-width: 0;
  }

  .tag-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
  }

  .tag-sub {
    margin-top: 3px;
    font-size: 12px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-close {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      background: var(--bg-3);
      color: var(--text-1);
    }
  }
}

.tag-current {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 34px;
  align-items: center;

  .tag-empty {
    font-size: 12.5px;
    color: var(--text-3);
  }
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 12.5px;
  cursor: pointer;
  transition: transform 0.2s var(--ease-out), filter 0.2s;

  &:hover {
    transform: translateY(-1px);
    filter: brightness(1.08);
  }

  &--ghost {
    background: var(--bg-2);
    border: 1px dashed var(--line);
    color: var(--text-2);

    &:hover {
      border-style: solid;
    }
  }

  .tag-chip-x {
    opacity: 0.65;
  }

  .tag-count {
    font-size: 10px;
    opacity: 0.75;
  }
}

.tag-add {
  display: flex;
  gap: 8px;

  .tag-input {
    flex: 1;
    height: 38px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg-2);
    color: var(--text-1);
    font-size: 13.5px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;

    &:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    &::placeholder {
      color: var(--text-3);
    }
  }

  .tag-add-btn {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 10px;
    background: var(--accent-grad);
    color: #fff;
    cursor: pointer;
    transition: transform 0.2s var(--ease-out), opacity 0.2s;

    &:hover {
      transform: translateY(-1px);
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
      transform: none;
    }
  }
}

/* 新标签类型：创建时按标题推荐，可当场改 */
.tag-newkind {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--accent-soft);
  border: 1px dashed color-mix(in srgb, var(--accent) 35%, transparent);
}

.tag-newkind-label {
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}

.tag-newkind-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-kind-opt {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);

  &.active {
    background: var(--accent-grad);
    border-color: transparent;
    color: #fff;
    font-weight: 600;
  }

  &:hover:not(.active) {
    border-color: var(--accent);
    color: var(--accent);
  }
}

.tag-newkind-hint {
  margin-left: auto;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--text-3);
  white-space: nowrap;
}

.tag-existing {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .tag-existing-title {
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--text-3);
    text-transform: uppercase;
  }

  .tag-existing-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
}

.tag-error {
  font-size: 12px;
  color: var(--accent);
}

.tag-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;

  .tag-saving {
    font-size: 11px;
    color: var(--text-3);
  }

  .tag-done {
    min-height: 36px;
    padding: 0 20px;
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    background: var(--bg-2);
    color: var(--text-1);
    font-size: 13.5px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s, transform 0.2s var(--ease-out);

    &:hover {
      border-color: var(--accent);
      color: var(--accent);
      transform: translateY(-1px);
    }
  }
}

.tag-fade-enter-active,
.tag-fade-leave-active {
  transition: opacity 0.18s var(--ease-out);
}

.tag-fade-enter-from,
.tag-fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .tag-panel {
    padding: 16px;
  }
}
</style>
