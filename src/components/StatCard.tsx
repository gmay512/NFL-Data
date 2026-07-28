type StatCardProps = {
  label: string
  value: string
  detail: string
}

export function StatCard({ label, value, detail }: StatCardProps) {
  return (
    <article className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-detail">{detail}</p>
    </article>
  )
}