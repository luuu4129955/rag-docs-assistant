/** 前端启动时用它确认登录态是否还有效 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return user
})
