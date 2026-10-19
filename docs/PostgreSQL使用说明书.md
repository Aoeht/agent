# PostgreSQL 使用说明书（零基础版）

> 写给第一次碰 PostgreSQL 的你。你本机已经装好了 **PostgreSQL 18**（服务名 `postgresql-x64-18`，开机自启，监听 `localhost:5432`），超级用户叫 `postgres`，密码是你安装时设的那个。
> 这份手册覆盖：怎么连接、怎么建库建表、日常命令行操作、CSV 数据集导入导出、`.sql` 文件怎么执行、备份恢复，以及怎么接入本项目（ai_agent）的知识库。所有命令都在你的机器上验证过环境（Win11 + PG 18 + Git Bash / PowerShell）。

---

## 目录

- [第 0 章 10 分钟上手路径](#第-0-章-10-分钟上手路径)
- [第 1 章 核心概念：实例、数据库、Schema、表](#第-1-章-核心概念实例数据库schema表)
- [第 2 章 连上数据库：三种打开方式 + 中文乱码治理](#第-2-章-连上数据库三种打开方式--中文乱码治理)
- [第 3 章 建库、切库、删库](#第-3-章-建库切库删库)
- [第 4 章 建表：类型、约束、本项目的真实表结构](#第-4-章-建表类型约束本项目的真实表结构)
- [第 5 章 增删改查（CRUD）+ 事务](#第-5-章-增删改查crud--事务)
- [第 6 章 CSV 导入导出（存数据集最常用）](#第-6-章-csv-导入导出存数据集最常用)
- [第 7 章 psql 命令速查表](#第-7-章-psql-命令速查表)
- [第 8 章 把 SQL 写进文件再执行](#第-8-章-把-sql-写进文件再执行)
- [第 9 章 用户与权限（给每个项目单独开账号）](#第-9-章-用户与权限给每个项目单独开账号)
- [第 10 章 备份与恢复](#第-10-章-备份与恢复)
- [第 11 章 接入 ai_agent 知识库](#第-11-章-接入-ai_agent-知识库)
- [第 12 章 服务管理（启动/停止/自启）](#第-12-章-服务管理启动停止自启)
- [第 13 章 常见报错速查](#第-13-章-常见报错速查)
- [第 14 章 图形化工具与下一步学习](#第-14-章-图形化工具与下一步学习)

---

## 第 0 章 10 分钟上手路径

赶时间的话，按这 5 步走一遍，每步的完整解释在后面章节：

```sql
-- 1. 开始菜单搜 "SQL Shell (psql)" 打开，Server/Database/Port/Username 全部回车，
--    Password 输安装时设的密码（输入时不显示任何字符，是正常的），看到 postgres=# 就是连上了

-- 2. 建一个自己的数据库（语句以分号结尾，回车执行）
CREATE DATABASE ai_agent;

-- 3. 切换进去
\c ai_agent

-- 4. 建一张表、插一行、查出来
CREATE TABLE hello (id int PRIMARY KEY, note text);
INSERT INTO hello VALUES (1, '我连上 PostgreSQL 了');
SELECT * FROM hello;

-- 5. 退出
\q
```

看到 `1 | 我连上 PostgreSQL 了` 就说明全流程通了。下面从头讲。

---

## 第 1 章 核心概念：实例、数据库、Schema、表

PG 的层级像俄罗斯套娃，一层包一层：

| 层级 | 类比 | 你机器上的现状 |
|---|---|---|
| **实例（服务）** | 整个软件本体，开机就在后台跑 | `postgresql-x64-18` 服务，监听 localhost:5432 |
| **数据库** | 实例里的一个个独立仓库，相互隔离 | `postgres`（默认库）、你其他项目建的库 |
| **Schema** | 库里的"文件夹"，用来分组表 | `public`（每库默认有）、`rag`（本项目知识库专用） |
| **表** | 真正存数据的表格（行列结构） | `rag.docs`、`rag.chunks`、`rag.vectors`、`rag.meta` |

三条必须记住的规则：

1. **一次连接只连一个数据库**。想操作另一个库要先 `\c 库名` 切换（见第 2 章）。
2. **跨数据库不能直接 JOIN**。所以"一个项目一个库"是最省心的组织方式。
3. **同库内用 schema 隔离**。ai_agent 知识库的全部表都在 `rag` 这个 schema 里，和你其他项目放在 `public` 或其他 schema 的数据集互不干扰。

表名的完整写法是 `schema.表名`，比如 `rag.docs`。不带前缀的 `docs` 指的是当前 search_path 里第一个匹配的（默认 public），**所以操作知识库的表请老老实实写 `rag.docs`**。

---

## 第 2 章 连上数据库：三种打开方式 + 中文乱码治理

### 2.1 方式一：SQL Shell (psql)——新手推荐

1. 按 `Win` 键，搜 **SQL Shell (psql)**，回车打开。
2. 它会依次问你 5 项，**前 4 项直接回车**（Server=localhost、Database=postgres、Port=5432、Username=postgres）：
   ```
   Server [localhost]:   ← 回车
   Database [postgres]:  ← 回车
   Port [5432]:          ← 回车
   Username [postgres]:  ← 回车
   客户端编码 [GB2312] 或 Password:  ← 见下方说明
   ```
   如果先问了"客户端编码"，输入 `UTF8` 回车；然后 Password 输安装时设的密码。**输入时屏幕不会显示任何字符**，连星号都没有，盲打完回车就行——这是新手第一次卡住的高发点。
3. 看到提示符变成 `postgres=#` 就连上了。

> 顺手把默认客户端编码固定下来：SQL Shell 里输入 `\encoding UTF8` 回车。一劳永逸的设置见 2.4。

### 2.2 方式二：PowerShell / CMD

psql 默认**不在 PATH 里**（你的机器已确认），先二选一：

- **办法 A（一次性配好 PATH，推荐）**：`Win` 搜"编辑系统环境变量" → 环境变量 → 上半区用户变量的 `Path` → 新建 → 填 `C:\Program Files\PostgreSQL\18\bin` → 确定。**重开**终端后 `psql --version` 能出版本号就成了。
- **办法 B（不配 PATH）**：每次用完整路径，PowerShell 里：

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql" -U postgres
```

配好 PATH 后的日常用法：

```powershell
psql -U postgres              # 连默认 postgres 库
psql -U postgres -d ai_agent  # 直接连指定库
psql -U postgres -c "SELECT version();"   # 不进交互界面，执行一句就走
```

### 2.3 方式三：Git Bash（本项目脚本同款环境）

```bash
psql -U postgres          # 配过 PATH 的话
```

### 2.4 治理中文乱码（Windows 必做一次）

Windows 控制台默认编码是 GBK 系，而 PG 里存的是 UTF-8，混着来就会看到 `娴嬭瘯` 这种火星文。三步根治：

```powershell
# PowerShell 里：
chcp 65001                                  # 控制台切到 UTF-8
setx PGCLIENTENCODING UTF8                  # 永久设置环境变量（对"新开"的窗口生效）
```

```bash
# Git Bash 里（写进 ~/.bashrc 一劳永逸）：
export PGCLIENTENCODING=UTF8
```

CMD 临时用：`chcp 65001 & set PGCLIENTENCODING=UTF8`

验证：连上后执行 `SELECT '中文测试';`，显示正常就完成了。

### 2.5 免每次输密码（可选）：pgpass 文件

新建文件 `%APPDATA%\postgresql\pgpass.conf`（资源管理器地址栏直接粘 `%APPDATA%\postgresql`，没有 postgresql 文件夹就建一个；文件要 **UTF-8 无 BOM** 编码），内容一行：

```
localhost:5432:*:postgres:你的密码
```

之后本机连接不再问密码。⚠️ 明文存密码，自己的电脑才这么做。

### 2.6 连接成功的标志与退出

- 成功：提示符 `数据库名=#`（如 `postgres=#`、`ai_agent=#`），井号 = 超级用户。
- 想退出：输入 `\q` 回车（任何时候都有效）。
- 中途输入到一半想放弃：`\r`（清空当前语句）或 `\q`（直接走人）。**别按 Ctrl+C**——Windows 控制台里那会直接杀掉整个 psql。

---

## 第 3 章 建库、切库、删库

以下都在 psql 提示符（`postgres=#`）里执行，**每条 SQL 以分号 `;` 结尾再回车**：

```sql
-- 看现在有哪些库（会列出 pg、模板库和你自己建的）
\l

-- 建库：名字用小写字母/数字/下划线，别用中文
CREATE DATABASE ai_agent;

-- 切换到刚建的库（这是 psql 元命令，不用分号）
\c ai_agent

-- 看当前在哪个库
SELECT current_database();

-- 删库（⚠️ 不可恢复；正在被连接的库删不掉，先让连接退出）
DROP DATABASE IF EXISTS 旧库名;
```

不进 psql、直接在命令行建库也行（配过 PATH 后）：

```powershell
createdb -U postgres ai_agent
```

新手规则三条：

1. **库别用中文和特殊字符命名**，大写字母会被悄悄转成小写（除非加双引号，别给自己找麻烦）。
2. **一个项目一个库**：你其他项目的数据集、ai_agent 的知识库，各在各的库里，互不干扰。
3. 删库跑路前先 `\l` 确认库名，`IF EXISTS` 防手滑报错。

---

## 第 4 章 建表：类型、约束、本项目的真实表结构

先 `\c` 到目标库，再建表。

### 4.1 常用类型速查

| 类型 | 用途 | 例子 |
|---|---|---|
| `text` | 任意长度文本（中文友好，首选） | 标题、正文、URL |
| `varchar(n)` | 限长文本，超长报错 | 用户名 |
| `integer` | 整数（±21 亿内） | 数量、状态码 |
| `bigint` | 大整数 | **毫秒时间戳**（本项目 `fetched_at` 就是它） |
| `numeric(p,s)` | 精确小数，金额必用 | `numeric(10,2)` → 12345678.90 |
| `real` / `double precision` | 浮点数 | 分数、**向量的分量** |
| `boolean` | 真/假 | 是否已处理 |
| `date` / `timestamptz` | 日期 / 带时区时间戳 | 创建时间（默认 `now()`） |
| `jsonb` | 结构化 JSON，可建索引可查询 | 模型输出的原始 JSON |
| `text[]` / `real[]` | 数组 | 标签列表；本项目向量就是 `real[]` |

经验法则：文本一律 `text`（不用纠结 varchar 长度）；金额用 `numeric` 不用浮点；时间戳要么 `timestamptz`（人类可读）要么 `bigint` 毫秒（程序好算），别混。

### 4.2 第一张表（把常用语法一次看全）

```sql
CREATE TABLE IF NOT EXISTS students (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 自增主键，不用你填
  name       text NOT NULL,                    -- 必填
  score      numeric(5,1) NOT NULL DEFAULT 0,  -- 默认值
  tags       text[] NOT NULL DEFAULT '{}',     -- 数组默认空数组
  extra      jsonb,                            -- 可空
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 看表结构（字段、类型、约束一目了然）
\d students
```

插入时 `id` 和 `created_at` 都不用管：

```sql
INSERT INTO students (name, score, tags) VALUES ('张三', 92.5, ARRAY['数学','竞赛']);
```

### 4.3 约束：让数据库替你把关

```sql
CREATE TABLE example (
  email   text UNIQUE NOT NULL,            -- 唯一 + 非空
  age     int CHECK (age >= 0),            -- 条件检查
  dept_id int REFERENCES departments(id)  -- 外键：值必须在 departments.id 里存在
);
```

违反约束的写入会直接报错——这不是坏事，是数据库在替你挡脏数据。

### 4.4 本项目知识库的四张表（真实结构，看懂即可，不用你建）

`rag` schema 下的表由程序**首次使用时自动创建**（`RAG_PG_URL` 配好后第一次检索/导入就建好了）。真实建表 SQL 长这样：

```sql
CREATE TABLE rag.docs (                 -- 一篇文档 = 一条记录（网页/Markdown 章节）
  id           text PRIMARY KEY,        -- sha1(归一化后的 source)
  source       text NOT NULL UNIQUE,    -- 来源：URL 或 internal://路径#章节
  title        text,
  trust        text NOT NULL CHECK (trust IN ('web', 'internal')),
  fetched_at   bigint NOT NULL,         -- 毫秒时间戳
  content_hash text NOT NULL            -- 内容指纹，用来判断"内容变没变"
);

CREATE TABLE rag.chunks (               -- 文档切出来的检索块
  id     text PRIMARY KEY,              -- 文档 id 前 12 位 # 序号
  doc_id text NOT NULL REFERENCES rag.docs (id) ON DELETE CASCADE,  -- 删文档连着删块
  seq    int NOT NULL,                  -- 块序号
  text   text NOT NULL
);

CREATE TABLE rag.meta (                 -- 键值对：revision 版本号（检索索引缓存用）
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE rag.vectors (              -- 向量缓存：模型+文本 的哈希 → 向量
  key        text PRIMARY KEY,
  model      text NOT NULL,             -- 产生向量的模型名（换模型旧向量自然失效）
  dims       int NOT NULL,
  embedding  real[] NOT NULL,           -- 1024 个浮点数
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`ON DELETE CASCADE` 的意思：删 `rag.docs` 里一条文档，它在 `rag.chunks` 里的所有块**自动跟着删**，不用你手动清。

### 4.5 删表与清空

```sql
DROP TABLE IF EXISTS students;   -- 连表带数据全删
TRUNCATE TABLE students;         -- 只清数据、表还在（比 DELETE 快，自增也重置）
DELETE FROM students;            -- 一行行删（可加 WHERE；不写 WHERE = 全删，危险）
```

---

## 第 5 章 增删改查（CRUD）+ 事务

拿第 4 章的 `students` 表练手。

### 5.1 插入

```sql
INSERT INTO students (name, score, tags) VALUES
  ('张三', 92.5, ARRAY['数学']),
  ('李四', 55.0, ARRAY['体育']),
  ('王五', 78.0, ARRAY['数学','物理'])
RETURNING *;              -- 把刚插入的行打出来确认，好习惯
```

### 5.2 查询（SELECT 是你 90% 的时间）

```sql
SELECT * FROM students;                                   -- 全部
SELECT name, score FROM students WHERE score >= 60;       -- 条件
SELECT * FROM students ORDER BY score DESC LIMIT 10;      -- 排序 + 前 10
SELECT * FROM students WHERE name LIKE '张%';             -- 模糊：姓张的（% 通配）
SELECT * FROM students WHERE '数学' = ANY(tags);           -- 数组包含
SELECT * FROM students WHERE extra @> '{"city": "北京"}';  -- jsonb 包含
SELECT count(*) FROM students;                            -- 统计行数
SELECT tags, count(*) FROM students GROUP BY tags;        -- 分组统计
```

条件连接词：`AND` / `OR` / `IN ('a','b')` / `BETWEEN 60 AND 80` / `IS NULL`（判空**不能**写 `= NULL`）。

### 5.3 修改与删除

```sql
UPDATE students SET score = 88 WHERE name = '张三';
DELETE FROM students WHERE score < 60;
```

> ⚠️ **新手保命两条**：
> 1. `UPDATE` / `DELETE` **不带 WHERE 就是对全表下手**。执行前先用同样的 WHERE 跑一遍 `SELECT`，确认命中的就是你想要的行。
> 2. 批量操作放进事务，看一眼结果再定去留：

```sql
BEGIN;
UPDATE students SET score = score + 5 WHERE tags @> ARRAY['数学'];
SELECT * FROM students WHERE tags @> ARRAY['数学'];   -- 检查
COMMIT;      -- 满意，落库
-- ROLLBACK; -- 反悔，全部撤销（二选一执行）
```

---

## 第 6 章 CSV 导入导出（存数据集最常用）

### 6.1 导入 CSV

```sql
-- psql 里执行；路径用正斜杠，文件头=表头
\copy students FROM 'D:/data/students.csv' WITH (FORMAT csv, HEADER true)
```

要求 CSV 列和表字段对应（同名表头最省事）。Excel 直接另存的 CSV 是 GBK 编码，导入乱码时加一个参数：

```sql
\copy students FROM 'D:/data/students.csv' WITH (FORMAT csv, HEADER true, ENCODING 'GBK')
```

（更推荐：用记事本/VS Code 把 CSV 另存为 **UTF-8** 后再导，一劳永逸。）

### 6.2 导出 CSV

```sql
-- 导整表
\copy students TO 'D:/data/students_out.csv' WITH (FORMAT csv, HEADER true)
-- 导查询结果（把 SELECT 包在括号里）
\copy (SELECT name, score FROM students WHERE score >= 60 ORDER BY score DESC) TO 'D:/data/及格名单.csv' WITH (FORMAT csv, HEADER true)
```

### 6.3 两个注意点

- `\copy` 是**客户端**命令，读写你电脑上的文件；大写的 `COPY ... FROM '/path'` 是服务端命令，要读服务器上的文件且需要管理员权限。日常用 `\copy` 就对了。
- 导入大批量前先建好表和约束；`\copy` 出错会整批失败，改好 CSV 重跑即可（想断点续传就按批次分文件）。

---

## 第 7 章 psql 命令速查表

反斜杠开头的是 psql 自己的"元命令"，**不加分号**；普通 SQL 才要分号。

| 命令                | 作用                                 |
| ----------------- | ---------------------------------- |
| `\l`              | 列出所有数据库                            |
| `\c 库名`           | 切换数据库                              |
| `\dn`             | 列出 schema                          |
| `\dt`             | 列当前库的表；`\dt rag.*` 只看 rag schema 的 |
| `\d 表名`           | 看表结构（字段/类型/约束/索引）                  |
| `\x`              | 切换纵向/横向显示（行太宽时先 `\x` 再查）           |
| `\pset pager off` | 关闭分页器（长结果不进 less，直接刷出来）            |
| `\timing`         | 开关：每条 SQL 显示耗时                     |
| `\i 文件.sql`       | 执行 SQL 文件（见第 8 章）                  |
| `\o 文件.txt`       | 后续查询结果同时写入文件；`\o` 单独执行则关闭          |
| `\r`              | 清空当前输入到一半的语句                       |
| `Ctrl+L`          | 清屏                                 |
| `\conninfo`       | 当前连接信息                             |
| `\q`              | 退出                                 |
| 上下方向键             | 翻历史命令（会话内有效）                       |

> ⚠️ **新手第一大坑**：SQL 没写分号就回车，提示符从 `postgres=#` 变成 `postgres-#`，回车多少遍都没反应。此时补一个 `;` 回车就能执行；想放弃就 `\r`。

---

## 第 8 章 把 SQL 写进文件再执行

建表语句、初始化数据写成一个 `.sql` 文件反复用，比在命令行里敲靠谱得多。

**第一步：写文件**。用 VS Code / 记事本新建 `D:/sql/init_students.sql`，**保存为 UTF-8 编码**（记事本：另存为 → 编码选 UTF-8）。内容示例：

```sql
-- 文件开头固定两句：指定编码 + 开事务（出错整体回滚）
SET client_encoding = 'UTF8';
BEGIN;

CREATE TABLE IF NOT EXISTS students (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  score numeric(5,1) NOT NULL DEFAULT 0
);

INSERT INTO students (name, score) VALUES ('张三', 90), ('李四', 85);

COMMIT;
```

**第二步：执行**，两种方式等价：

```sql
-- 方式 A：先连进 psql（记得 \c 到目标库），再用 \i
\i D:/sql/init_students.sql

-- 方式 B：命令行一步到位（-f 指定文件，-d 指定库）
psql -U postgres -d ai_agent -f D:/sql/init_students.sql
```

三个注意点：

1. **路径用正斜杠** `D:/sql/...`，反斜杠会被当转义字符吃掉。
2. 文件编码必须 UTF-8，否则中文注释/数据变乱码。
3. 文件里 `BEGIN; ... COMMIT;` 包起来，任何一句失败整体回滚，不会出现"表建了但数据没插进去"的半成品状态。

---

## 第 9 章 用户与权限（给每个项目单独开账号）

你现在的所有操作都用 `postgres` 这个超级用户——它什么都能干，**日常图省事可以继续用**。等哪天要把数据库分享给其他程序/其他人，再按下面给每个项目单独开账号，权限最小化：

```sql
-- 1. 建用户（CREATE USER = 能登录的角色）
CREATE USER ai_agent_app WITH PASSWORD '给这个用户设的密码';

-- 2. 允许它连某个库、用某个 schema
GRANT CONNECT ON DATABASE ai_agent TO ai_agent_app;
GRANT USAGE ON SCHEMA rag TO ai_agent_app;

-- 3. 授权表操作
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rag TO ai_agent_app;
-- 以后新建的表也自动授权：
ALTER DEFAULT PRIVILEGES IN SCHEMA rag GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_agent_app;
```

之后该项目的连接串就用这个用户：`postgres://ai_agent_app:密码@localhost:5432/ai_agent`，它能干的只有授权范围内的事。

改密码（忘了/要换）：

```sql
ALTER USER postgres WITH PASSWORD '新密码';
ALTER USER ai_agent_app WITH PASSWORD '新密码';
```

> 彻底忘了 postgres 密码怎么办：把 `C:\Program Files\PostgreSQL\18\data\pg_hba.conf` 里的 `scram-sha-256`/`md5` 临时改成 `trust`（管理员权限编辑）→ 服务重启（第 12 章）→ 此时免密连入执行上面的 `ALTER USER` → 把 pg_hba.conf 改回来 → 再重启。

---

## 第 10 章 备份与恢复

数据集是命根子，`pg_dump` 一条命令搞定。以下在 PowerShell（配过 PATH）里执行：

```powershell
# 备份整个库为压缩格式（推荐，体积小恢复快）
pg_dump -U postgres -d ai_agent -F c -f D:/backup/ai_agent.dump

# 备份为纯 SQL 文本（可读、可 grep，适合小库）
pg_dump -U postgres -d ai_agent -f D:/backup/ai_agent.sql

# 只备份知识库这两张表
pg_dump -U postgres -d ai_agent -t rag.docs -t rag.chunks -f D:/backup/rag_tables.sql
```

没配 PATH 就用完整路径：`& "C:\Program Files\PostgreSQL\18\bin\pg_dump" ...`；没配 pgpass 时先 `$env:PGPASSWORD="你的密码"` 再执行。

恢复：

```powershell
# 恢复压缩格式（-c = 先清掉已有对象再灌入）
pg_restore -U postgres -d ai_agent -c D:/backup/ai_agent.dump

# 恢复纯 SQL
psql -U postgres -d ai_agent -f D:/backup/ai_agent.sql
```

建议：项目数据有变动就 `pg_dump` 一次，按日期存 `D:/backup/ai_agent_2026-10-17.dump`；勤快的话用 Windows 任务计划程序每天自动跑一条（任务里填上面那条命令即可）。

---

## 第 11 章 接入 ai_agent 知识库

项目已内置 PostgreSQL 后端，按顺序三步：

**① 配连接串**。`.env` 里取消注释并填好（格式逐段解释）：

```ini
# postgres://用户名:口令@主机:5432/库名
#            ↓        ↓      ↓        ↓   ↓
RAG_PG_URL=postgres://postgres:你的口令@localhost:5432/ai_agent
# 建议上面第 3 章先 CREATE DATABASE ai_agent; 让知识库有独立库
# RAG_PG_SCHEMA=rag   ← schema 名，默认就叫 rag，一般不用改
```

**② 迁移现有数据**（项目根目录执行，把 `.rag-cache` 里的 JSON 数据搬进 PG，幂等可重跑）：

```bash
bun run rag:migrate-pg
```

**③ 验证**。psql 连到那个库（`\c ai_agent`），跑：

```sql
\dt rag.*
SELECT count(*) AS 文档数   FROM rag.docs;
SELECT count(*) AS 块数     FROM rag.chunks;
SELECT count(*) AS 向量数   FROM rag.vectors;
SELECT count(*) FROM rag.vectors WHERE model = 'qwen3.7-text-embedding-flash';
```

日常管理的常用 SQL：

```sql
-- 最近导入的 5 篇（fetched_at 是毫秒时间戳，用 to_timestamp 转人类时间）
SELECT source, title, trust, to_timestamp(fetched_at / 1000.0) AS 导入时间
FROM rag.docs ORDER BY fetched_at DESC LIMIT 5;

-- 看某篇文档切成了哪些块（每块前 50 字）
SELECT seq, left(text, 50) AS 预览
FROM rag.chunks
WHERE doc_id = (SELECT id FROM rag.docs WHERE source = 'https://某个网址')
ORDER BY seq;

-- 手动删一篇文档（chunks 会级联自动删）
DELETE FROM rag.docs WHERE source = 'https://某个网址';

-- 清空整个知识库重新来（表结构下次使用时程序自动重建）
DROP SCHEMA IF EXISTS rag CASCADE;

-- 看向量缓存的模型与规模
SELECT model, count(*), avg(dims) FROM rag.vectors GROUP BY model;
```

行为说明：

- 配了 `RAG_PG_URL` 后，`rag_search` 工具和 `bun run rag:ingest` 导入**自动读写 PG**；注释掉该行即回到 JSON 文件模式，两边数据各自独立互不覆盖。
- 想删 JSON 那份缓存直接删 `.rag-cache/` 文件夹即可，不影响 PG 里的数据。
- ⚠️ 上面所有 `rag.*` SQL 要在 `RAG_PG_URL` 指向的那个**库**里执行（先 `\c` 过去），连错库会看到 "relation does not exist"。

---

## 第 12 章 服务管理（启动/停止/自启）

```powershell
Get-Service *postgres*          # 看服务名和状态（你的是 postgresql-x64-18）
net stop postgresql-x64-18      # 停止（要管理员 PowerShell）
net start postgresql-x64-18     # 启动
```

不想敲命令：`Win+R` → `services.msc` → 找到 `postgresql-x64-18` → 右键。默认是开机自启的，平时完全不用管它。

---

## 第 13 章 常见报错速查

| 报错（关键字） | 原因 | 解法 |
|---|---|---|
| `password authentication failed` | 密码不对 | 重输；真忘了看第 9 章末尾的重置流程 |
| `SASL: client password must be a string` | 连接串里没写口令 | `postgres://postgres:口令@...` 补上 |
| `database "xxx" does not exist` | 库名拼错或没建 | `\l` 对照；`CREATE DATABASE` |
| `relation "xxx" does not exist` | 表不在当前库/当前 schema | 先 `\c` 对库；表名带前缀 `rag.docs`；`\dt` 确认 |
| `Connection refused` / `ECONNREFUSED` | 服务没启动 | 第 12 章启动服务 |
| `syntax error at end of input` | SQL 忘写分号 | 补 `;`（提示符是 `-#` 时） |
| `syntax error at or near "xxx"` | 关键字拼错/中文标点 | 检查是否用了中文引号、中文括号、全角逗号 |
| 中文变 `娴嬭瘯` | 控制台编码 GBK | 第 2.4 节三步治理 |
| `value too long for type character varying(n)` | 超长 | 改列 `ALTER TABLE t ALTER COLUMN c TYPE text;` |
| `port 5432 already in use` / 重复装了两个 PG | 端口冲突 | 用 5433 端口那个，或卸载多余的 |
| `cannot drop ... because other objects depend on it` | 有外键依赖 | 加 `CASCADE`（先想清楚） |

万能排查顺序：**看完整报错第一行 → 对照本表 → 还不行就把 `SELECT version();` 和完整报错一起拿去问**。

---

## 第 14 章 图形化工具与下一步学习

命令行是基本功，但日常浏览数据用图形工具更舒服：

- **pgAdmin 4**：装 PG 18 时自带（开始菜单搜 pgAdmin），连 localhost:5432 + postgres 即可，浏览表、点开直接编辑。
- **DBeaver**（免费开源，推荐）：支持所有数据库，SQL 编辑器比 pgAdmin 好用，`dbeaver.io/download` 下 Community 版。
- **VS Code 插件**：搜 "PostgreSQL"（ckolkman 出品），库浏览器 + 查询直接在编辑器里跑。

学习路线建议（按顺序，总共一个周末）：

1. 把本手册第 4、5 章的例子亲手敲一遍（不是复制粘贴）。
2. SQL 练习闯关：sqlbolt.com（英文但全交互，几十道小题）。
3. 中文系统教程：菜鸟教程 PostgreSQL 板块，或官方文档的 tutorial 部分（postgresql.org/docs/current/tutorial.html）。
4. 用你真实的数据集走一遍第 6 章 CSV 导入 → 第 5 章查询分析 → 第 10 章备份的完整闭环。

---

*本文档由 ai_agent 项目维护；项目侧的 RAG 知识库行为说明见 [使用说明书 4.6 节](使用说明书.md)。*
