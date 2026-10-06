import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Segments from './views/Segments.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: App },
    { path: '/segments', component: Segments }
  ]
});
