import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  requiredText,
  optionalText,
  enumOrEmpty,
  isOwnCloudinaryUrl,
  requiredUrl,
  validateImages,
  deriveHashtags,
  validateMentions,
  validatePoll
} from "../api/_lib/validators.js";
import { ApiError } from "../api/_lib/errors.js";

function assertApiError(fn, status) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

describe("requiredText", () => {
  test("trims and returns valid text", () => {
    assert.equal(requiredText("  hello  ", "text", 10), "hello");
  });

  test("rejects empty string", () => {
    assertApiError(() => requiredText("", "text", 10), 400);
  });

  test("rejects whitespace-only string", () => {
    assertApiError(() => requiredText("   ", "text", 10), 400);
  });

  test("rejects non-string input", () => {
    assertApiError(() => requiredText(42, "text", 10), 400);
    assertApiError(() => requiredText(null, "text", 10), 400);
    assertApiError(() => requiredText(undefined, "text", 10), 400);
  });

  test("rejects text exceeding maxLen", () => {
    assertApiError(() => requiredText("a".repeat(11), "text", 10), 400);
  });

  test("accepts text exactly at maxLen", () => {
    assert.equal(requiredText("a".repeat(10), "text", 10), "a".repeat(10));
  });
});

describe("optionalText", () => {
  test("returns empty string for undefined/null", () => {
    assert.equal(optionalText(undefined, "text", 10), "");
    assert.equal(optionalText(null, "text", 10), "");
  });

  test("trims valid text", () => {
    assert.equal(optionalText("  hi  ", "text", 10), "hi");
  });

  test("rejects text exceeding maxLen", () => {
    assertApiError(() => optionalText("a".repeat(11), "text", 10), 400);
  });

  test("non-string input is treated as empty", () => {
    assert.equal(optionalText(42, "text", 10), "");
  });
});

describe("enumOrEmpty", () => {
  const allowed = ["a", "b", "c"];

  test("accepts empty string", () => {
    assert.equal(enumOrEmpty("", "field", allowed), "");
  });

  test("accepts allowed value", () => {
    assert.equal(enumOrEmpty("b", "field", allowed), "b");
  });

  test("rejects disallowed value", () => {
    assertApiError(() => enumOrEmpty("z", "field", allowed), 400);
  });

  test("treats a non-string value as empty rather than throwing", () => {
    assert.equal(enumOrEmpty(5, "field", allowed), "");
  });
});

describe("isOwnCloudinaryUrl", () => {
  const folder = "posts";
  const validUrl = "https://res.cloudinary.com/s9htrtz2/image/upload/v123/posts/abc.jpg";

  test("accepts a well-formed cloudinary image URL in the right folder", () => {
    assert.equal(isOwnCloudinaryUrl(validUrl, folder), true);
  });

  test("accepts raw upload type", () => {
    assert.equal(
      isOwnCloudinaryUrl("https://res.cloudinary.com/s9htrtz2/raw/upload/v1/posts/doc.pdf", folder),
      true
    );
  });

  test("rejects wrong folder", () => {
    assert.equal(isOwnCloudinaryUrl(validUrl, "resources"), false);
  });

  test("rejects wrong host", () => {
    assert.equal(
      isOwnCloudinaryUrl("https://evil.com/s9htrtz2/image/upload/v1/posts/x.jpg", folder),
      false
    );
  });

  test("rejects non-https protocol", () => {
    assert.equal(
      isOwnCloudinaryUrl("http://res.cloudinary.com/s9htrtz2/image/upload/v1/posts/x.jpg", folder),
      false
    );
  });

  test("rejects malformed URL", () => {
    assert.equal(isOwnCloudinaryUrl("not a url", folder), false);
  });

  test("rejects non-string input", () => {
    assert.equal(isOwnCloudinaryUrl(null, folder), false);
    assert.equal(isOwnCloudinaryUrl(undefined, folder), false);
  });

  test("rejects overly long URL", () => {
    const longUrl = validUrl + "a".repeat(600);
    assert.equal(isOwnCloudinaryUrl(longUrl, folder), false);
  });
});

describe("requiredUrl", () => {
  test("accepts valid https URL", () => {
    assert.equal(requiredUrl("https://example.com/doc", "link"), "https://example.com/doc");
  });

  test("accepts valid http URL", () => {
    assert.equal(requiredUrl("http://example.com", "link"), "http://example.com");
  });

  test("rejects non-URL string", () => {
    assertApiError(() => requiredUrl("not a url", "link"), 400);
  });

  test("rejects unsupported protocol", () => {
    assertApiError(() => requiredUrl("ftp://example.com/file", "link"), 400);
  });

  test("rejects empty value", () => {
    assertApiError(() => requiredUrl("", "link"), 400);
  });
});

describe("validateImages", () => {
  const folder = "posts";
  const goodUrl = "https://res.cloudinary.com/s9htrtz2/image/upload/v1/posts/a.jpg";

  test("returns empty array for undefined/null", () => {
    assert.deepEqual(validateImages(undefined, folder), []);
    assert.deepEqual(validateImages(null, folder), []);
  });

  test("rejects non-array input", () => {
    assertApiError(() => validateImages("not-an-array", folder), 400);
  });

  test("accepts array of valid URLs within max", () => {
    assert.deepEqual(validateImages([goodUrl, goodUrl], folder), [goodUrl, goodUrl]);
  });

  test("rejects array exceeding max count", () => {
    assertApiError(() => validateImages(Array(7).fill(goodUrl), folder, 6), 400);
  });

  test("rejects array containing an invalid URL", () => {
    assertApiError(() => validateImages([goodUrl, "https://evil.com/x.jpg"], folder), 400);
  });
});

describe("deriveHashtags", () => {
  test("extracts hashtags in lowercase, deduplicated", () => {
    assert.deepEqual(
      new Set(deriveHashtags("Hello #World and #world again #Test")),
      new Set(["world", "test"])
    );
  });

  test("returns empty array when no hashtags present", () => {
    assert.deepEqual(deriveHashtags("plain text with no tags"), []);
  });

  test("ignores hashtags shorter than 2 characters", () => {
    assert.deepEqual(deriveHashtags("just #a here"), []);
  });

  test("supports Bengali characters in hashtags", () => {
    assert.deepEqual(deriveHashtags("খবর #বাংলা আজকে"), ["বাংলা"]);
  });

  test("truncates hashtags longer than 40 characters at the boundary", () => {
    const long = "x".repeat(45);
    const [tag] = deriveHashtags(`#${long}`);
    assert.equal(tag.length, 40);
  });
});

describe("validatePoll", () => {
  test("returns null for undefined/null", () => {
    assert.equal(validatePoll(undefined), null);
    assert.equal(validatePoll(null), null);
  });

  test("rejects malformed poll (no options array)", () => {
    assertApiError(() => validatePoll({}), 400);
    assertApiError(() => validatePoll("not an object"), 400);
  });

  test("returns null when fewer than 2 non-empty options remain", () => {
    assert.equal(validatePoll({ options: [{ text: "only one" }] }), null);
    assert.equal(validatePoll({ options: [] }), null);
  });

  test("builds a valid poll with votes initialized empty", () => {
    const poll = validatePoll({
      options: [{ text: "Yes" }, { text: "No" }]
    });
    assert.equal(poll.options.length, 2);
    assert.deepEqual(poll.votes, {});
    assert.equal(poll.options[0].text, "Yes");
  });

  test("caps options at 6", () => {
    const raw = { options: Array.from({ length: 10 }, (_, i) => ({ text: `opt${i}` })) };
    const poll = validatePoll(raw);
    assert.equal(poll.options.length, 6);
  });

  test("filters out options with blank text", () => {
    const poll = validatePoll({
      options: [{ text: "Yes" }, { text: "   " }, { text: "No" }]
    });
    assert.equal(poll.options.length, 2);
  });

  test("rejects an option text longer than 80 characters", () => {
    assertApiError(
      () => validatePoll({ options: [{ text: "a".repeat(81) }, { text: "b" }] }),
      400
    );
  });

  test("assigns fallback ids when option id is missing", () => {
    const poll = validatePoll({ options: [{ text: "Yes" }, { text: "No" }] });
    assert.equal(poll.options[0].id, "opt0");
    assert.equal(poll.options[1].id, "opt1");
  });
});

describe("validateMentions", () => {
  function makeFakeDb(users) {
    return {
      collection(name) {
        assert.equal(name, "users");
        return {
          doc(uid) {
            return { _uid: uid };
          }
        };
      },
      async getAll(...refs) {
        return refs.map((ref) => {
          const user = users[ref._uid];
          return {
            exists: !!user,
            get(field) {
              return user ? user[field] : undefined;
            }
          };
        });
      }
    };
  }

  test("returns empty array for undefined/null", async () => {
    const db = makeFakeDb({});
    assert.deepEqual(await validateMentions(db, undefined, "caller1"), []);
    assert.deepEqual(await validateMentions(db, null, "caller1"), []);
  });

  test("rejects non-array input", async () => {
    const db = makeFakeDb({});
    await assert.rejects(() => validateMentions(db, "nope", "caller1"), ApiError);
  });

  test("resolves mentions whose uid/name match a real user", async () => {
    const db = makeFakeDb({ u1: { name: "Rafi" } });
    const out = await validateMentions(db, [{ uid: "u1", name: "Rafi" }], "caller1");
    assert.deepEqual(out, [{ uid: "u1", name: "Rafi" }]);
  });

  test("drops mentions whose name does not match the stored name", async () => {
    const db = makeFakeDb({ u1: { name: "Rafi" } });
    const out = await validateMentions(db, [{ uid: "u1", name: "Spoofed Name" }], "caller1");
    assert.deepEqual(out, []);
  });

  test("drops mentions of nonexistent users", async () => {
    const db = makeFakeDb({});
    const out = await validateMentions(db, [{ uid: "ghost", name: "Nobody" }], "caller1");
    assert.deepEqual(out, []);
  });

  test("excludes the caller from mentioning themselves", async () => {
    const db = makeFakeDb({ caller1: { name: "Me" } });
    const out = await validateMentions(db, [{ uid: "caller1", name: "Me" }], "caller1");
    assert.deepEqual(out, []);
  });

  test("caps mentions at the max count", async () => {
    const users = {};
    const raw = [];
    for (let i = 0; i < 25; i++) {
      users[`u${i}`] = { name: `User${i}` };
      raw.push({ uid: `u${i}`, name: `User${i}` });
    }
    const db = makeFakeDb(users);
    const out = await validateMentions(db, raw, "caller1", 20);
    assert.equal(out.length, 20);
  });
});
