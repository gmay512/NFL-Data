import { Link } from 'react-router-dom'

type FeatureCardProps = {
  title: string
  description: string
  href?: string
}

export function FeatureCard({ title, description, href }: FeatureCardProps) {
  if (href) {
    return (
      <Link className="feature-card feature-card-link" to={href}>
        <h3>{title}</h3>
        <p>{description}</p>
      </Link>
    )
  }

  return (
    <article className="feature-card">
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  )
}