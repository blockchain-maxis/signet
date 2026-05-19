import type { ReactNode } from "react";

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      {children}
    </div>
  );
}
