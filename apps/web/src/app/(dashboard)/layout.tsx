import Link from "next/link";
import { ReactNode } from "react";
import { Button } from "@/components/ui/button";

const nav = [
  { href: "/calendar", label: "Kalendari / Calendar" },
  { href: "/bookings", label: "Rezervimet / Bookings" },
  { href: "/staff", label: "Stafi / Staff" },
  { href: "/services", label: "Shërbimet / Services" },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl">
        {/* Sidebar */}
        <aside className="hidden w-72 border-r bg-background md:flex md:flex-col">
          <div className="flex items-center justify-between border-b p-4">
            <div className="leading-tight">
              <div className="text-sm font-semibold">PLANTAK</div>
              <div className="text-xs text-muted-foreground">
                Dashboard / Paneli
              </div>
            </div>
            <Button asChild size="sm" variant="secondary">
              <Link href="/calendar">Open</Link>
            </Button>
          </div>

          <nav className="flex flex-col gap-1 p-2">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-xl px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="mt-auto border-t p-4">
            <div className="text-xs text-muted-foreground">
              Enterprise-ready: Multi-business, Staff schedules, Anti double-booking
            </div>
          </div>
        </aside>

        {/* Main */}
        <div className="flex flex-1 flex-col">
          <header className="flex items-center justify-between border-b p-4">
            <div>
              <div className="text-sm font-semibold">
                Mirësevini / Welcome
              </div>
              <div className="text-xs text-muted-foreground">
                Calendar + bookings engine
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/calendar">Kalendari / Calendar</Link>
              </Button>
            </div>
          </header>

          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
