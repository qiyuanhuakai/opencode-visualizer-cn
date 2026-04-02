import { createApp } from 'vue';
import '@xterm/xterm/css/xterm.css';
import './styles/tailwind.css';
import App from './App.vue';
import { i18n } from './i18n';

// Dynamically inject CSS Custom Highlight API styles to avoid build warnings
function injectHighlightStyles(): void {
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `
    ::highlight(fw-search) {
      background: rgba(234, 179, 8, 0.35);
      color: #fef08a;
    }
    ::highlight(fw-search-current) {
      background: rgba(59, 130, 246, 0.58);
      color: #ffffff;
    }
  `;
  document.head.appendChild(style);
}

const app = createApp(App);
app.use(i18n);
app.mount('#app');
injectHighlightStyles();
