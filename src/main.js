import { createApp } from 'vue'
import { createPinia } from 'pinia'; // 导入 Pinia
import App from './App.vue';
import router from './router'

import './assets/global.css'
import './js/icon'

const pinia = createPinia();
const app = createApp(App);
app.use(pinia)

app.use(router)
app.mount('#app');