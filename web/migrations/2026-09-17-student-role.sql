-- 统一「没有职务」的存储，并清掉混进 roles 表的预置职位行
--
-- 背景：同一个意思在库里出现过三种写法 —— 注册走 '学生'，编辑成员不勾任何职务走 '[]'，
-- 更早的数据还有空串 / NULL。三种都不授权任何权限（'学生' 不在 ROLE_PERMISSIONS 里），
-- 但会一路传到前端的职务徽章与「按职位选择提醒对象」，所以统一成 '学生' 一种。
-- 写入端也已归口到 utils/permissions.js 的 positionsToStore（注册与编辑成员共用），
-- 所以这条迁移只管存量，跑完之后不该再有新的旧写法出现。
--
-- 语句可重复执行。

UPDATE users SET positions = '学生'
 WHERE positions IS NULL
    OR TRIM(positions) = ''
    OR TRIM(positions) = '[]';

-- 预置职位（学生 / 班长 / 团支书 / 学习委员）的权限写死在代码里，roles 表里不该有同名行。
-- 写入口已经堵住（assertCustomRoleName / handleCreateRole），这里清掉可能的存量：
-- 一行「学生」尤其危险 —— 它不给任何人报错，只会顺着 buildRoleMap 叠加到全班默认成员身上。
--
-- 这段清理原先单独放在 2026-09-11-security.sql（那份文件只有这一句，现已并入本文件）。
-- buildRoleMap 现在也一并忽略预置名（与库里有没有这行无关），所以就算本次不清，它也不会再生效 ——
-- 删掉只是让库和代码一致。

DELETE FROM roles WHERE name IN ('学生', '班长', '团支书', '学习委员');
