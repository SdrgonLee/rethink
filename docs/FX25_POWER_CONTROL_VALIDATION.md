# LG FX25 power control validation

The `FX___N` power switch was validated against a physical LG FX25 washer on
2026-09-03. The validation used rethink in transparent bridge mode, Home
Assistant MQTT discovery, and the official ThinQ integration as an independent
state reference.

## Implemented scope

Power is the only writable FX25 property exposed by rethink. Course selection,
options, start, pause/resume, remote start, and laundry care remain read-only or
unimplemented.

Home Assistant discovery intentionally exposes two separate entities:

- `Power`, a read-only binary sensor reporting the appliance state.
- `Power control`, a switch using the same state topic and a dedicated command
  topic.

Keeping these entities separate avoids changing the identity and platform of
the existing power sensor.

## Command frames

The frames emitted by Home Assistant matched frames captured from the official
ThinQ app byte-for-byte:

| Operation | AABB frame |
| --- | --- |
| Power ON | `AA0DF0E5000201FF010201C7BB` |
| Power OFF | `AA0DF0E5000201FF010200C4BB` |

Both operations received the appliance acknowledgement
`AA082000E500E2BB`. Subsequent `0xE6` and `0x98` state snapshots reported the
corresponding real appliance state. The switch does not update optimistically;
it waits for this appliance-reported state.

## End-to-end result

An ON followed by OFF was issued through the rethink `Power control` entity.
For both transitions:

- The command frame and appliance acknowledgement were observed.
- The rethink `Power` sensor and `Power control` switch converged on the same
  state.
- The official ThinQ integration independently reported the matching state.
- The physical appliance performed the requested operation.

## Restart and recovery result

The Home Assistant add-on was restarted while the appliance was powered off.
During restart, the MQTT entities correctly became unavailable. The appliance
then established a new session and all 21 FX25 entities recovered without
duplicates or loss in approximately 27 seconds.

After recovery, another ON/OFF cycle was issued through Home Assistant:

| Phase | rethink power control | rethink power sensor | rethink status | Official ThinQ status |
| --- | --- | --- | --- | --- |
| ON | On | Running | Initial | Standby |
| OFF | Off | Not running | Off | Off |

The add-on remained running and no new runtime error was observed after the
restart and power cycle. The final appliance state was OFF.

## Automated coverage

The FX25 tests verify that:

- The existing status entities remain read-only.
- The isolated power switch publishes the expected discovery configuration.
- ON and OFF writes produce the captured official ThinQ frames exactly.
- Unknown power values and unrelated write requests transmit nothing.
