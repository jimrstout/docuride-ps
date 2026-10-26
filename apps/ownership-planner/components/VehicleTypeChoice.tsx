"use client";

// components/VehicleTypeChoice.tsx: the vehicle type on Verify.
//
// A radio group at the top of the Vehicle panel, because the vehicle type
// decides the menu and the version of each product TecAssured will contract:
// a street bike given the Off-Road Tire and Wheel is refused at contract time.
// Choosing one saves the sheet straight away, so the change takes effect and
// the deal asks for Confirm and Continue again, like any rating input.

import { useRef } from "react";

export const VEHICLE_TYPE_CHOICES = [
  "ATV",
  "UTV",
  "On-Road Motorcycle",
  "Off-Road Motorcycle",
  "Scooter",
  "Personal Watercraft",
  "Snowmobile",
  "Other",
] as const;

export default function VehicleTypeChoice({
  value,
  line,
  edited,
}: {
  value: string | null;
  /** Where the choice came from, in one plain line. */
  line: string | null;
  edited: boolean;
}) {
  const group = useRef<HTMLFieldSetElement>(null);

  function onChange() {
    group.current?.closest("form")?.requestSubmit();
  }

  return (
    <fieldset ref={group} className={`vtype${edited ? " vtype--edited" : ""}`} aria-describedby="vtype-line">
      <legend>Vehicle type</legend>
      <div className="vtype-choices" role="radiogroup">
        {VEHICLE_TYPE_CHOICES.map((choice) => (
          <label key={choice} className={`vtype-choice${value === choice ? " is-chosen" : ""}`}>
            <input type="radio" name="vehicle_type" value={choice} defaultChecked={value === choice} onChange={onChange} />
            <span>{choice}</span>
          </label>
        ))}
      </div>
      <p id="vtype-line" className="vtype-line">
        {line ?? "Choose the vehicle type. It decides the menu and what TecAssured is asked."}
      </p>
    </fieldset>
  );
}
