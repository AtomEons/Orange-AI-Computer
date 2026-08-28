import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'

import type {
  PartyLineConnection,
  PartyLineDetail,
  PartyLineEvent,
  PartyLineEventType,
} from '@/lib/orange-party-line'

const EVENT_COLORS: Record<PartyLineEventType, number> = {
  message: 0x8b5cf6,
  order: 0xff8a1f,
  report: 0x22d3ee,
  decision: 0x38bdf8,
  tool: 0x14b8a6,
  receipt: 0xf8fafc,
  status: 0x84cc16,
  blocker: 0xff355e,
  repair: 0xfbbf24,
}

const DETAIL_LIMIT: Record<PartyLineDetail, number> = {
  quiet: 24,
  normal: 64,
  deep: 120,
  wire: 240,
}

const disposeGroup = (group: THREE.Group) => {
  for (const child of [...group.children]) {
    group.remove(child)
    const object = child as THREE.Mesh | THREE.Line | THREE.Points
    object.geometry?.dispose()
    const material = object.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose()
  }
}

export function PartyLineSignalField({
  events,
  detail,
  connection,
}: {
  events: PartyLineEvent[]
  detail: PartyLineDetail
  connection: PartyLineConnection
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<THREE.Group | null>(null)
  const [available, setAvailable] = useState(true)

  const visibleEvents = useMemo(
    () => events.slice(-DETAIL_LIMIT[detail]),
    [detail, events]
  )
  const actorCount = useMemo(
    () => new Set(visibleEvents.map((event) => event.actor.id)).size,
    [visibleEvents]
  )
  const latest = visibleEvents.at(-1)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch {
      setAvailable(false)
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0x030303, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'absolute inset-0 size-full'
    renderer.domElement.setAttribute('aria-hidden', 'true')
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x030303, 0.1)
    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 40)
    camera.position.set(0, 0.35, 8.4)
    camera.lookAt(0, 0, 0)

    const field = new THREE.Group()
    field.rotation.x = -0.08
    scene.add(field)
    fieldRef.current = field

    const grid = new THREE.GridHelper(13, 26, 0x5f2d0c, 0x15100d)
    grid.position.y = -2.35
    grid.position.z = -0.4
    scene.add(grid)

    let targetX = -0.08
    let targetY = 0
    const pointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      targetY = ((event.clientX - rect.left) / rect.width - 0.5) * 0.18
      targetX = -0.08 + ((event.clientY - rect.top) / rect.height - 0.5) * 0.08
    }
    host.addEventListener('pointermove', pointer)

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    const animate = (time: number) => {
      if (!document.hidden) {
        field.rotation.x += (targetX - field.rotation.x) * 0.035
        field.rotation.y += (targetY - field.rotation.y) * 0.035
        if (!reducedMotion) {
          field.rotation.z = Math.sin(time * 0.00018) * 0.018
          field.children.forEach((child) => {
            if (child.userData.signalNode !== true) return
            const phase = Number(child.userData.phase || 0)
            const pulse = 1 + Math.sin(time * 0.004 + phase) * 0.14
            child.scale.setScalar(pulse)
          })
        }
        renderer.render(scene, camera)
      }
      frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      host.removeEventListener('pointermove', pointer)
      disposeGroup(field)
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      renderer.dispose()
      renderer.domElement.remove()
      fieldRef.current = null
    }
  }, [])

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    disposeGroup(field)
    if (!visibleEvents.length) return

    const actors = [...new Set(visibleEvents.map((event) => event.actor.id))]
    const actorLane = new Map(actors.map((actor, index) => [actor, index]))
    const laneCount = Math.max(1, actors.length - 1)
    const positions: number[] = []
    const colors: number[] = []
    const lastPosition = new Map<string, THREE.Vector3>()
    const color = new THREE.Color()

    visibleEvents.forEach((event, index) => {
      const progress = visibleEvents.length === 1 ? 1 : index / (visibleEvents.length - 1)
      const lane = actorLane.get(event.actor.id) ?? 0
      const x = -4.6 + progress * 9.2
      const y = actors.length === 1 ? 0 : 1.8 - (lane / laneCount) * 3.6
      const z = Math.sin(event.seq * 0.41 + lane * 0.9) * 0.62 + event.importance * 0.35
      positions.push(x, y, z)
      color.setHex(EVENT_COLORS[event.eventType])
      colors.push(color.r, color.g, color.b)
      lastPosition.set(event.actor.id, new THREE.Vector3(x, y, z))
    })

    const pathGeometry = new THREE.BufferGeometry()
    pathGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    pathGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const path = new THREE.Line(
      pathGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
      })
    )
    field.add(path)

    const pointGeometry = new THREE.BufferGeometry()
    pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    field.add(
      new THREE.Points(
        pointGeometry,
        new THREE.PointsMaterial({
          size: detail === 'quiet' ? 0.085 : 0.115,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
        })
      )
    )

    actors.forEach((actor, index) => {
      const event = [...visibleEvents].reverse().find((item) => item.actor.id === actor)
      const position = lastPosition.get(actor)
      if (!event || !position) return
      const node = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.13, 0),
        new THREE.MeshBasicMaterial({
          color: EVENT_COLORS[event.eventType],
          wireframe: event.actor.kind !== 'operator',
          transparent: true,
          opacity: 0.96,
        })
      )
      node.position.copy(position)
      node.userData.signalNode = true
      node.userData.phase = index * 0.83
      field.add(node)
    })
  }, [detail, visibleEvents])

  return (
    <section className="relative h-48 shrink-0 overflow-hidden border-b border-white/8 bg-black" aria-label="Live Party Line signal field">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <div>
          <div className="font-mono text-[8px] font-black uppercase text-primary">Chromatic Signal Field</div>
          <div className="mt-1 font-mono text-[8px] uppercase text-white/35">
            {available ? connection : 'webgl unavailable'} / {visibleEvents.length} events / {actorCount} actors
          </div>
        </div>
        <div className="border border-white/10 bg-black/65 px-2 py-1 font-mono text-[8px] uppercase text-white/45 backdrop-blur-sm">
          {latest ? `${latest.actor.displayName} / ${latest.eventType}` : 'waiting for signal'}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[7px] uppercase text-white/35">
        <span className="text-orange-400">operator</span>
        <span className="text-violet-400">model</span>
        <span className="text-emerald-400">agent</span>
        <span className="text-cyan-400">tool/report</span>
        <span className="text-red-400">blocker</span>
        <span className="text-amber-300">repair</span>
      </div>
    </section>
  )
}
