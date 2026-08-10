import { createRouter, createWebHashHistory } from 'vue-router'

// 定义路由规则
const routes = [
  {
    path: '/',          // 封面页路径
    name: 'Cover',
    component: () => import('@/components/LayOut.vue') // 封面组件
  },
  {
    path: '/browse',         // 文件浏览页路径
    name: 'Browse',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/reading/:id',    // 阅读页路径
    name: 'Reading',
    component: () => import('@/components/Reading.vue') // 阅读组件
  }
]

// 创建路由实例
// const base = typeof process !== 'undefined' ? process.env.BASE_URL : '/'
const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router