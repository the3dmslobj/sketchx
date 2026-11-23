/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/**/*.{html,js}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { arcade: ['"Press Start 2P"', "monospace"], body: ['"Inter"', "system-ui", "sans-serif"] },
      colors: { neon: { pink: "#ff3cac", cyan: "#2de2e6", lime: "#a6ff4d", amber: "#ffb800" } },
    },
  },
};
