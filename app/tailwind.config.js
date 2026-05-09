/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0e1116',
          secondary: '#161b22',
          tertiary: '#1c2128'
        },
        accent: {
          DEFAULT: '#2f7cf6',
          hover: '#4c92ff'
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Hiragino Sans"', 'Meiryo', 'sans-serif'],
        mono: ['"SF Mono"', 'Menlo', 'Monaco', 'monospace']
      }
    }
  },
  plugins: []
}
