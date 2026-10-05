-- 统一生命周期、稳定受众、持久投递与同步序号。
CREATE TABLE IF NOT EXISTS architecture_versions (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS audience_migration_issues (
  kind TEXT NOT NULL, item_id INTEGER NOT NULL, legacy_value TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
CREATE TABLE IF NOT EXISTS orphan_submission_archive AS
  SELECT * FROM form_submissions WHERE form_id NOT IN (SELECT id FROM forms);
DELETE FROM form_submissions WHERE form_id NOT IN (SELECT id FROM forms);
CREATE TABLE IF NOT EXISTS form_submissions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, student_id TEXT, name TEXT, answers TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(form_id, user_id)
);
INSERT OR IGNORE INTO form_submissions_v2 SELECT * FROM form_submissions;
DROP TABLE form_submissions;
ALTER TABLE form_submissions_v2 RENAME TO form_submissions;
CREATE INDEX idx_form_submissions_form ON form_submissions(form_id);
CREATE TABLE IF NOT EXISTS form_notice_links (
  operation_key TEXT PRIMARY KEY,
  form_id INTEGER NOT NULL UNIQUE REFERENCES forms(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS forms_delete_notice AFTER DELETE ON forms BEGIN
  DELETE FROM notices WHERE id = OLD.notice_id;
END;
CREATE TRIGGER IF NOT EXISTS notices_clear_link AFTER DELETE ON notices BEGIN
  UPDATE forms SET notice_id = NULL WHERE notice_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS users_delete_subscriptions AFTER DELETE ON users BEGIN
  DELETE FROM push_subscriptions WHERE user_id = OLD.id;
  DELETE FROM email_subscriptions WHERE user_id = OLD.id;
  DELETE FROM email_codes WHERE user_id = OLD.id;
END;

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'notices', id, remind_people FROM notices
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE notices SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'activities', id, remind_people FROM activities
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE activities SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'forms', id, remind_people FROM forms
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE forms SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

CREATE TABLE IF NOT EXISTS content_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('notices','activities','forms')),
  item_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_changes_item ON content_changes(kind, item_id, seq);
CREATE TABLE IF NOT EXISTS outbox_events (
  seq INTEGER PRIMARY KEY REFERENCES content_changes(seq),
  expanded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER NOT NULL REFERENCES outbox_events(seq),
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email','push')),
  target TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','dead','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT,
  UNIQUE(event_seq, channel, target)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_ready ON outbox_deliveries(state, next_at, lease_until);

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'notices', id, 'update', json_object('id', id, 'title', title, 'content', content, 'publish_time', publish_time, 'publisher', publisher, 'remind_people', remind_people, 'source', source, 'expire_time', expire_time, 'link', link, 'created_by', created_by, 'created_at', created_at) FROM notices WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS notices_change_create AFTER INSERT ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'publish_time', NEW.publish_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'source', NEW.source, 'expire_time', NEW.expire_time, 'link', NEW.link, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS notices_change_update AFTER UPDATE ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'publish_time', NEW.publish_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'source', NEW.source, 'expire_time', NEW.expire_time, 'link', NEW.link, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS notices_change_delete AFTER DELETE ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'content', OLD.content, 'publish_time', OLD.publish_time, 'publisher', OLD.publisher, 'remind_people', OLD.remind_people, 'source', OLD.source, 'expire_time', OLD.expire_time, 'link', OLD.link, 'created_by', OLD.created_by, 'created_at', OLD.created_at));
END;

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'activities', id, 'update', json_object('id', id, 'title', title, 'content', content, 'location', location, 'start_time', start_time, 'end_time', end_time, 'publisher', publisher, 'remind_people', remind_people, 'created_by', created_by, 'created_at', created_at) FROM activities WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS activities_change_create AFTER INSERT ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'location', NEW.location, 'start_time', NEW.start_time, 'end_time', NEW.end_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS activities_change_update AFTER UPDATE ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'location', NEW.location, 'start_time', NEW.start_time, 'end_time', NEW.end_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS activities_change_delete AFTER DELETE ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'content', OLD.content, 'location', OLD.location, 'start_time', OLD.start_time, 'end_time', OLD.end_time, 'publisher', OLD.publisher, 'remind_people', OLD.remind_people, 'created_by', OLD.created_by, 'created_at', OLD.created_at));
END;

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'forms', id, 'update', json_object('id', id, 'title', title, 'description', description, 'fields', fields, 'edit_policy', edit_policy, 'anonymous', anonymous, 'status', status, 'deadline', deadline, 'creator_id', creator_id, 'creator_name', creator_name, 'remind_people', remind_people, 'notice_id', notice_id, 'created_at', created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=forms.id))) FROM forms WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS forms_change_create AFTER INSERT ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'description', NEW.description, 'fields', NEW.fields, 'edit_policy', NEW.edit_policy, 'anonymous', NEW.anonymous, 'status', NEW.status, 'deadline', NEW.deadline, 'creator_id', NEW.creator_id, 'creator_name', NEW.creator_name, 'remind_people', NEW.remind_people, 'notice_id', NEW.notice_id, 'created_at', NEW.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=NEW.id))));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS forms_change_update AFTER UPDATE ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'description', NEW.description, 'fields', NEW.fields, 'edit_policy', NEW.edit_policy, 'anonymous', NEW.anonymous, 'status', NEW.status, 'deadline', NEW.deadline, 'creator_id', NEW.creator_id, 'creator_name', NEW.creator_name, 'remind_people', NEW.remind_people, 'notice_id', NEW.notice_id, 'created_at', NEW.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=NEW.id))));
END;
CREATE TRIGGER IF NOT EXISTS forms_change_delete AFTER DELETE ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'description', OLD.description, 'fields', OLD.fields, 'edit_policy', OLD.edit_policy, 'anonymous', OLD.anonymous, 'status', OLD.status, 'deadline', OLD.deadline, 'creator_id', OLD.creator_id, 'creator_name', OLD.creator_name, 'remind_people', OLD.remind_people, 'notice_id', OLD.notice_id, 'created_at', OLD.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=OLD.id))));
END;
INSERT OR IGNORE INTO architecture_versions(version) VALUES (1);

-- 提交状态变化也推进表单同步序号，数据与序号在同一事务中可见。
CREATE TRIGGER IF NOT EXISTS submission_change_insert AFTER INSERT ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=NEW.form_id;
END;
CREATE TRIGGER IF NOT EXISTS submission_change_update AFTER UPDATE ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=NEW.form_id;
END;
CREATE TRIGGER IF NOT EXISTS submission_change_delete AFTER DELETE ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=OLD.form_id;
END;
