/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pane: {
          bg: '#0f1419',
          border: '#1e2836',
          hover: '#1a2332'
        }
      }
    }
  },
  plugins: []
}
