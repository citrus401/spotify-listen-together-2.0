import spotStyles from '../styles/Spot.module.css'

const ClientList = (props: {listeners?: [{name: string, isHost: boolean, watchingAD: boolean}]}) => {
  return (
    <div className={`${spotStyles.list} ${spotStyles.box}`}>
      {
        props.listeners?.map((client, i) => 
          <div key={i} className={spotStyles.text}>{client.name}
            {client.isHost?
              <span title='Host'>🕹️</span>
            : <></>}
            {client.watchingAD?
              <span title='Watching an AD'>💵</span>
            : <></>}
          </div>
        )
      }
    </div>
  )
}

export default ClientList
