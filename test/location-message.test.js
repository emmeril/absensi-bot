const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLocationMessage } = require("../lib/location-message");

function locationMessage(overrides = {}) {
  return {
    type: "location",
    isForwarded: false,
    forwardingScore: 0,
    location: {
      latitude: -6.7594116,
      longitude: 108.5112901,
    },
    ...overrides,
  };
}

test("accepts a direct location with valid coordinates", () => {
  assert.deepEqual(validateLocationMessage(locationMessage()), {
    valid: true,
    location: {
      latitude: -6.7594116,
      longitude: 108.5112901,
    },
  });
});

test("rejects forwarded locations", () => {
  assert.equal(
    validateLocationMessage(locationMessage({ isForwarded: true })).reason,
    "forwarded"
  );
  assert.equal(
    validateLocationMessage(locationMessage({ forwardingScore: 1 })).reason,
    "forwarded"
  );
});

test("rejects searched places and map pins", () => {
  const msg = locationMessage({
    location: {
      latitude: -6.7594116,
      longitude: 108.5112901,
      name: "Sekolah",
      address: "Jalan Sekolah",
    },
  });

  assert.equal(validateLocationMessage(msg).reason, "place_pin");
});

test("rejects missing or out-of-range coordinates", () => {
  assert.equal(
    validateLocationMessage(
      locationMessage({ location: { latitude: 91, longitude: 0 } })
    ).reason,
    "invalid_coordinates"
  );
  assert.equal(validateLocationMessage({ type: "chat" }).reason, "not_location");
});
