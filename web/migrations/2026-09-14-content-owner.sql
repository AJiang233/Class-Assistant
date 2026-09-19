-- 通知 / 活动的归属（issue #17）
--
-- 背景：update / delete 只校验了 content:write，不校验调用者是不是创建者，
-- 于是持有 content:write 的「学习委员」可以改删班长发布的任何内容，
-- 还能顺手把 publisher 改成别人的署名。
--
-- 迁移前的历史行 created_by 为 NULL —— 这类记录一律按「需要 user:manage」处理
-- （见 utils/audience.js 的 canManageItem），不一刀切拒绝，否则老内容谁都动不了。
--
-- 一次性的 ALTER：重复执行会报 duplicate column name，属预期（同其它迁移脚本）。

ALTER TABLE notices ADD COLUMN created_by INTEGER;
ALTER TABLE activities ADD COLUMN created_by INTEGER;
