import { createComment } from "./_handlers/create-comment.js";
import { createPost } from "./_handlers/create-post.js";
import { createProfile } from "./_handlers/create-profile.js";
import { createResource } from "./_handlers/create-resource.js";
import { deadlineReminders } from "./_handlers/deadline-reminders.js";
import { deleteComment } from "./_handlers/delete-comment.js";
import { editComment } from "./_handlers/edit-comment.js";
import { editPost } from "./_handlers/edit-post.js";
import { editResource } from "./_handlers/edit-resource.js";
import { resolveProfile } from "./_handlers/resolve-profile.js";
import { sendDmMessage } from "./_handlers/send-dm-message.js";
import { sendPush } from "./_handlers/send-push.js";
import { signUpload } from "./_handlers/sign-upload.js";
import { updateDisposableDomains } from "./_handlers/update-disposable-domains.js";
import { updateProfile } from "./_handlers/update-profile.js";

const routes = {
  "create-comment": createComment,
  "create-post": createPost,
  "create-profile": createProfile,
  "create-resource": createResource,
  "deadline-reminders": deadlineReminders,
  "delete-comment": deleteComment,
  "edit-comment": editComment,
  "edit-post": editPost,
  "edit-resource": editResource,
  "resolve-profile": resolveProfile,
  "send-dm-message": sendDmMessage,
  "send-push": sendPush,
  "sign-upload": signUpload,
  "update-disposable-domains": updateDisposableDomains,
  "update-profile": updateProfile
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const action = req.query.action;
  const fn = routes[action];
  if (!fn) {
    return res.status(404).json({ error: "Not found." });
  }
  return fn(req, res);
}