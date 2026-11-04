import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              debugName: 'dashboard-vendors',
              name(id) {
                if (id.includes('node_modules/echarts/')) return 'charts';
                if (id.includes('node_modules/zrender/')) return 'canvas';
                if (id.includes('node_modules/@vue/') || id.includes('node_modules/vue/'))
                  return 'vue';
                return null;
              },
            },
          ],
        },
      },
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
