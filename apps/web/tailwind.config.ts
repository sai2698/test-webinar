import type { Config } from 'tailwindcss';

const config: Config = {
  // The console ships a manual light/dark switch, so the theme is driven by a
  // class on <html> rather than the OS preference.
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens. Each resolves to an RGB triplet held in a CSS
        // variable, so `bg-panel/60` and friends keep working while the
        // palette swaps between themes.
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        'panel-2': 'rgb(var(--panel-2) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        ink: {
          950: '#05060a',
          900: '#0a0c14',
          850: '#0f1220',
          800: '#141829',
          700: '#1d2236',
          600: '#2a3049',
        },
        brand: {
          50: '#eef4ff',
          100: '#dbe6ff',
          200: '#bdd0ff',
          300: '#93b0ff',
          400: '#6285ff',
          500: '#3d5cff',
          600: '#2a3ef5',
          700: '#222fd8',
          800: '#1f2aae',
          900: '#1f2b89',
        },
        accent: {
          400: '#ffb84d',
          500: '#ff9f1c',
          600: '#f57c00',
        },
        mint: {
          400: '#3ddc97',
          500: '#22c98a',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,255,255,0.06), 0 20px 60px -20px rgba(61,92,255,0.55)',
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(circle at 50% 0%, rgba(61,92,255,0.18), transparent 60%), linear-gradient(to bottom, #05060a, #0a0c14)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.24,0,0.38,1) infinite',
        shimmer: 'shimmer 2.5s linear infinite',
        float: 'float 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
