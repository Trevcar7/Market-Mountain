import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Email Preferences",
  description: "Manage your Market Mountain email subscription and notification preferences.",
};

export default function PreferencesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
