import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection } from "firebase/firestore";

const ADMIN_EMAIL = "in.with.imran@gmail.com";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "geohub-rules-test",
    firestore: {
      rules: fs.readFileSync("firestore.rules", "utf8")
    }
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe("users/{uid}", () => {
  test("signed-out user cannot read a profile", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "users/alice")));
  });

  test("signed-in user can read any profile", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice" });
    });
    const db = testEnv.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(db, "users/alice")));
  });

  test("a user cannot create their own profile document directly", async () => {
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(db, "users/alice"), { name: "Alice" }));
  });

  test("a user can update only their own lastActive field", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice", lastActive: null });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(updateDoc(doc(db, "users/alice"), { lastActive: Date.now() }));
  });

  test("a user cannot update another user's profile", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice" });
    });
    const db = testEnv.authenticatedContext("bob").firestore();
    await assertFails(updateDoc(doc(db, "users/alice"), { lastActive: Date.now() }));
  });

  test("a user cannot change fields other than lastActive", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice" });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(db, "users/alice"), { name: "Someone Else" }));
  });

  test("no one can delete a profile document, not even the owner", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice" });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertFails(deleteDoc(doc(db, "users/alice")));
  });

  test("admin can delete a profile document", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { name: "Alice" });
    });
    const db = testEnv.authenticatedContext("admin-uid", { email: ADMIN_EMAIL }).firestore();
    await assertFails(deleteDoc(doc(db, "users/alice")));
  });
});

describe("posts/{postId}", () => {
  test("owner can delete their own post", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts/p1"), { authorUid: "alice", text: "hi" });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(deleteDoc(doc(db, "posts/p1")));
  });

  test("a non-owner, non-admin user cannot delete a post", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts/p1"), { authorUid: "alice", text: "hi" });
    });
    const db = testEnv.authenticatedContext("bob").firestore();
    await assertFails(deleteDoc(doc(db, "posts/p1")));
  });

  test("admin can delete any post", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts/p1"), { authorUid: "alice", text: "hi" });
    });
    const db = testEnv.authenticatedContext("admin-uid", { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(deleteDoc(doc(db, "posts/p1")));
  });

  test("admin can pin a post by only changing pinned/pinnedAt", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts/p1"), { authorUid: "alice", text: "hi" });
    });
    const db = testEnv.authenticatedContext("admin-uid", { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(updateDoc(doc(db, "posts/p1"), { pinned: true, pinnedAt: Date.now() }));
  });

  test("admin cannot edit post text via the pin path", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts/p1"), { authorUid: "alice", text: "hi" });
    });
    const db = testEnv.authenticatedContext("admin-uid", { email: ADMIN_EMAIL }).firestore();
    await assertFails(updateDoc(doc(db, "posts/p1"), { text: "edited by admin" }));
  });
});

describe("dms/{convoId}", () => {
  test("a participant can read their conversation", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "dms/c1"), { participants: ["alice", "bob"] });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(db, "dms/c1")));
  });

  test("a non-participant cannot read the conversation", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "dms/c1"), { participants: ["alice", "bob"] });
    });
    const db = testEnv.authenticatedContext("eve").firestore();
    await assertFails(getDoc(doc(db, "dms/c1")));
  });

  test("no one can delete a DM conversation thread", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "dms/c1"), { participants: ["alice", "bob"] });
    });
    const db = testEnv.authenticatedContext("alice").firestore();
    await assertFails(deleteDoc(doc(db, "dms/c1")));
  });
});
