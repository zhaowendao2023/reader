<script setup>
import { useBooks } from "../store/loadBooks";
import { getMOBI } from "../utils/bookData";
const index = inject("index");
const toces = inject("toces");
const containerRef = ref(null);
const book = ref(null);
const bookInfo = inject("bookInfo");
const images = ref([]);
const cssVars = useBooks().cssVarsData;

const loadMobi = async (bookPath) => {
  book.value = await getMOBI(bookPath);
  for (const section of book.value.sections) {
    const url = await section.load();
    const html = await fetchChapterContent(url);
    const div = document.createElement("div");
    div.innerHTML = html;
    containerRef.value.appendChild(div);
  }
  toces.value = book.value.toc;
};

async function fetchChapterContent(url) {
  const response = await fetch(url);
  const html = await response.text();
  return html;
}
onMounted(async () => {
  await loadMobi(bookInfo.value.path);
});

const x = ref(0);
const y = ref(0);
const showPopover = ref(false);
const popover = ref("");

const loadIndex = async (e) => {
  e.preventDefault();
  showPopover.value = false;
  if (e.target.tagName === "A") {
    if (!e.target.id || e.target.id.endsWith("n")) {
      jump(e.target.href);
    } else {
      const note = (await getGoal(e.target.href))?.parentNode;
      if (!showPopover.value) {
        showPopover.value = true;
        x.value = e.clientX;
        y.value = e.clientY;
      }
      popover.value = note.innerText;
    }
  }
  index.value.total = Math.ceil(
    containerRef.value.scrollHeight / containerRef.value.clientHeight
  );
  index.value.nowIndex = Math.floor(
    containerRef.value.scrollTop / containerRef.value.clientHeight
  );
};

const jump = (href) => {
  getGoal(href).then((goal) => {
    goal?.scrollIntoView({ behavior: "smooth" }); // 平滑滚动
  });
};
const getGoal = async (href) => {
  const { saved } = await book.value.resolveHref(href);

  return containerRef.value.querySelector(saved);
};

const left = () => {
  index.value.nowIndex -= 1;
  containerRef.value.scrollBy({
    top: -containerRef.value.clientHeight,
    behavior: "smooth",
  });
};

const right = () => {
  index.value.nowIndex += 1;
  containerRef.value.scrollBy({
    top: containerRef.value.clientHeight,
    behavior: "smooth",
  });
};

defineExpose({
  jump,
  left,
  right,
});
</script>

<template>
  <div>
    <n-popover
      :show="showPopover"
      :x="x"
      :y="y"
      trigger="manual"
      :width="'30vw'"
    >
      {{ popover }}
    </n-popover>
    <div ref="containerRef" class="text" @click="loadIndex"></div>
  </div>
</template>

<style scoped lang="scss">
.text {
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  overflow-x: hidden;
  font-size: v-bind("cssVars.fontSize + 'px'");
  * {
    font-family: "TangHan";
  }

  :deep([class*="toc"]) {
    a {
      color: var(--color) !important;
    }
  }

  :deep(p) {
    padding: 0 2vw;
    margin-bottom: v-bind("cssVars.marginBottom + 'em'");
    font-size: v-bind("cssVars.fontSize + 'px'");
    letter-spacing: v-bind("cssVars.letterSpacing + 'px'");
    line-height: v-bind("cssVars.lineHeight");

    a {
      padding: 0;
    }
  }

  :deep(a) {
    text-decoration: none;
    padding: 0 2vw;
    padding-bottom: var(--p-margin-bottom);
    overflow-wrap: break-word;
    color: var(--a-color) !important;
  }

  :deep(h2),
  :deep(h3) {
    padding: 0 2vw;
    color: var(--color) !important;
  }

  :deep(img) {
    max-width: 100%;
    width: -webkit-fill-available;
    height: auto;
    display: block;
    margin: 0 auto;
  }
}

:deep(div.chubanshe) {
  position: inherit;
}
</style>
