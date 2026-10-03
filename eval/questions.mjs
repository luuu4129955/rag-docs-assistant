/**
 * RAG 评测集：题目都按知识库里真实存在（或真实不存在）的内容来出。
 *
 * expect:
 *   answer —— 材料里有，应该答出来，并且带引用编号
 *   refuse —— 材料里没有，应该拒答（不管是在服务端被阈值拦下，还是模型自己说没有）
 *
 * type:
 *   in-doc   文档内直接可答
 *   literal  带专有名词/编号，考字面精确匹配（混合检索的关键词那一路）
 *   adjacent 相关但材料确实没写（最容易骗过阈值的一类）
 *   off-topic 完全无关
 */
export const questions = [
  // ---- 文档内：应该答出来并带引用 ----
  {
    id: 1,
    type: 'in-doc',
    expect: 'answer',
    q: '前端采集这一层都采哪些数据？',
    note: '链路地图把前端采集分成性能、异常、埋点几类',
  },
  {
    id: 2,
    type: 'in-doc',
    expect: 'answer',
    q: '前端指标和 LLM 调用怎么用同一个 Trace ID 串起来？',
    note: '链路地图第 6 节点专门讲这件事',
  },
  {
    id: 3,
    type: 'in-doc',
    expect: 'answer',
    q: 'LLM 指标要定义哪些？',
    note: '首 Token 延迟、Token 消耗、成本、检索命中、幻觉率',
  },
  {
    id: 4,
    type: 'in-doc',
    expect: 'answer',
    q: '全栈 AI 监控链路里，数据管道和存储分别用什么？',
    note: 'Kafka 做管道、ClickHouse 做存储',
  },
  {
    id: 5,
    type: 'in-doc',
    expect: 'answer',
    q: '初中级、中高级、专家级分别对应哪些链路节点？',
    note: '链路地图末尾有一张对应表',
  },
  {
    id: 6,
    type: 'in-doc',
    expect: 'answer',
    q: '代码分割主要做了哪几件事？',
    note: '性能优化描述：按需引入、vendor 拆分、Tree Shaking',
  },
  {
    id: 7,
    type: 'in-doc',
    expect: 'answer',
    q: '主包体积是怎么降下来的？',
    note: 'manualChunks 拆 vendor chunk，主包从约 569KB 降到约 62KB',
  },
  {
    id: 8,
    type: 'in-doc',
    expect: 'answer',
    q: 'Markdown 渲染是怎么规避 XSS 的？',
    note: 'markdown-it 解析成 Token 再遍历生成，不直接渲染 HTML 字符串',
  },
  {
    id: 9,
    type: 'in-doc',
    expect: 'answer',
    q: '图片这类静态资源在优化时怎么处理？',
    note: '上传前压缩，用 Canvas/OffscreenCanvas 限制宽度',
  },
  {
    id: 10,
    type: 'in-doc',
    expect: 'answer',
    q: '生产构建时怎么去掉 console 和 debugger？',
    note: 'TerserPlugin / esbuild minify 开 drop_console、drop_debugger',
  },

  // ---- 字面精确匹配：考混合检索（关键词那一路）----
  {
    id: 16,
    type: 'literal',
    expect: 'answer',
    q: 'manualChunks 是怎么用的？',
    note: '专有名词，关键词那一路应该能直接命中',
  },
  {
    id: 17,
    type: 'literal',
    expect: 'answer',
    q: 'OpenTelemetry 在链路里做什么？',
    note: '专有名词，出现在链路地图的节点清单里',
  },
  {
    id: 18,
    type: 'literal',
    expect: 'answer',
    q: 'TerserPlugin 和 esbuild minify 分别用在哪里？',
    note: '两个工具名同时出现，考字面匹配与并列召回',
  },

  // ---- 相关但材料里没写：应该拒答 ----
  {
    id: 11,
    type: 'adjacent',
    expect: 'refuse',
    q: '这套监控体系在大促期间的 QPS 峰值是多少？',
    note: '材料只讲链路设计，没有任何容量数据',
  },
  {
    id: 12,
    type: 'adjacent',
    expect: 'refuse',
    q: 'Kafka 集群用了几台机器、怎么扩容？',
    note: '材料里出现 Kafka 这个词，但没有部署细节',
  },
  {
    id: 13,
    type: 'adjacent',
    expect: 'refuse',
    q: '重排序模型在这个项目里具体怎么接？',
    note: '材料没提重排序的实现方案',
  },

  // ---- 完全无关：应该拒答 ----
  {
    id: 14,
    type: 'off-topic',
    expect: 'refuse',
    q: '今天上海天气怎么样？',
    note: '与知识库无关',
  },
  {
    id: 15,
    type: 'off-topic',
    expect: 'refuse',
    q: '用 Python 写一个快速排序',
    note: '与知识库无关',
  },
]
