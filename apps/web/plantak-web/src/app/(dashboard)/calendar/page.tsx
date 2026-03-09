"use client";

import * as React from "react";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function CalendarPage() {
  const [date, setDate] = React.useState<Date | undefined>(new Date());

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Kalendari / Calendar</CardTitle>
          <div className="text-sm text-muted-foreground">
            Zgjedh datën për me pa slotet & rezervimet / Pick a date to view slots & bookings
          </div>
        </CardHeader>
        <CardContent>
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            className="rounded-xl border"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detaje / Details</CardTitle>
          <div className="text-sm text-muted-foreground">
            Këtu do dalin: staff selector, slots, bookings / Staff selector, slots, bookings
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="rounded-xl border p-3">
            <div className="font-medium">Data / Date</div>
            <div className="text-muted-foreground">
              {date ? date.toISOString().slice(0, 10) : "—"}
            </div>
          </div>

          <div className="rounded-xl border p-3">
            <div className="font-medium">Hapi tjetër / Next step</div>
            <div className="text-muted-foreground">
              Staff dropdown + fetch availability nga API (3001) + grid slots si Planity.
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
