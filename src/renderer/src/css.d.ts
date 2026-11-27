declare module '*.css'
declare module '@fontsource-variable/inter'
declare module '*?url' {
  const src: string
  export default src
}
declare module '*.png' {
  const src: string
  export default src
}
declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module '*.svg' {
  const src: string
  export default src
}
