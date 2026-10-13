import { Hanken_Grotesk, Space_Mono } from "next/font/google";

// UI face + machine face (§17). Exposed as CSS variables consumed by dashboard.css.
export const uiFont = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

export const monoFont = Space_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const fontClasses = `${uiFont.variable} ${monoFont.variable}`;
