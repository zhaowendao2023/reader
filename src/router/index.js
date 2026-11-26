import { createRouter, createWebHashHistory } from 'vue-router'

// 定义路由规则
const routes = [
  {
    path: '/',          // 主界面（全量聚合中心）
    name: 'Home',
    component: () => import('@/components/LayOut.vue') // 封面组件
  },
  {
    path: '/shelf',         // 收藏（分门别类的书架）
    name: 'Shelf',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/browse',         // 文件夹预览（资源管理器）
    name: 'Browse',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/search',         // 搜索结果独立页
    name: 'Search',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/tags',           // 按标签浏览
    name: 'Tags',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/settings',       // 设置页
    name: 'Settings',
    component: () => import('@/components/LayOut.vue')
  },
  {
    path: '/reading/:id',    // 阅读页路径
    name: 'Reading',
    component: () => import('@/components/Reading.vue') // 阅读组件
  },
  {
    path: '/video/:id',
    name: 'VideoPlayer',
    component: () => import('@/components/VideoPlayer.vue')
  },
  {
    path: '/media/:id',
    name: 'MediaViewer',
    component: () => import('@/components/MediaViewer.vue')
  },
  {
    path: '/media-pack/:id',
    name: 'MediaPack',
    component: () => import('@/components/MediaPack.vue')
  }
]

// 创建路由实例
// const base = typeof process !== 'undefined' ? process.env.BASE_URL : '/'
const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
