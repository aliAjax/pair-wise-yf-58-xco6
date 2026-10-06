import 'ant-design-vue/dist/reset.css';
import { createApp } from 'vue';
import Antd from 'ant-design-vue';
import { createPinia } from 'pinia';
import Root from './Root.vue';
import { i18n } from './i18n';
import { router } from './router';

createApp(Root).use(createPinia()).use(router).use(i18n).use(Antd).mount('#app');
